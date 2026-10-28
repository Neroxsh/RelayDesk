import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeExecutable } from "./providers.mjs";
import { activeClaudeSessions, claudeHome } from "./claude-sessions.mjs";
import { getClaudeCapabilities } from "./claude-status.mjs";
import { invalidateSessions } from "./sessions.mjs";

const localRuns = new Set();

export function claudeArgs(session, settings = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.id)) throw new Error("Claude 会话 ID 无效");
  const args = ["-p", session.isNew ? "--session-id" : "--resume", session.id, "--output-format", "stream-json", "--verbose"];
  if (settings.model) {
    if (!/^[\w.:/()@+-]{1,160}$/.test(settings.model)) throw new Error("模型名称无效");
    args.push("--model", settings.model);
  }
  if (settings.reasoning) {
    if (!["low", "medium", "high", "xhigh", "max"].includes(settings.reasoning)) throw new Error("Claude 不支持这个思考强度");
    args.push("--effort", settings.reasoning);
  }
  if (settings.permission === "full") args.push("--permission-mode", "bypassPermissions");
  else if (settings.permission === "read-only") args.push("--permission-mode", "plan");
  else args.push("--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep,Edit,Write");
  return args;
}

export function claudeEvent(row) {
  if (row.type === "assistant") {
    const text = row.message?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text) return { type: "assistant", text };
  }
  if (row.type === "system" && row.subtype === "init") return { type: "settings", model: row.model, permissionMode: row.permissionMode };
  return null;
}

export async function sendClaudePrompt(session, prompt, settings, onEvent) {
  const features = await getClaudeCapabilities();
  if (!features.available || !features.resume || !features.stream || !features.permissions) throw new Error("当前 Claude Code 缺少恢复、结构化输出或权限接口，请升级后再发送；历史仍可查看");
  if (session.isNew && !features.newSession) throw new Error("当前 Claude Code 版本不支持按 ID 新建会话，请升级后再试");
  if (settings.reasoning && !features.reasoningEfforts.includes(settings.reasoning)) throw new Error("这个 Claude Code 版本不支持所选思考强度，请改回跟随电脑或升级");
  if (localRuns.has(session.id)) throw new Error("这个 Claude 会话正在执行，请等待或停止");
  if ((await activeClaudeSessions()).some((row) => row.sessionId === session.id)) throw new Error("这个 Claude 会话仍在电脑终端打开。请先退出该会话，或在手机新建 Claude 会话，避免两个进程同时写入。");
  if (localRuns.has(session.id)) throw new Error("这个 Claude 会话正在执行，请等待或停止");
  const executable = claudeExecutable();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome() };
  // A global provider switch must use fresh local settings, rather than credentials
  // inherited by the long-lived agent at Windows login.
  const local = await readFile(path.join(claudeHome(), "settings.json"), "utf8").then(JSON.parse).catch(() => ({}));
  if (local.env && typeof local.env === "object") {
    for (const key of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CODE_OAUTH_/.test(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(local.env ?? {})) env[key] = String(value);
  const args = claudeArgs(session, settings);
  if (localRuns.has(session.id)) throw new Error("这个 Claude 会话正在执行，请等待或停止");
  localRuns.add(session.id);
  let child;
  try { child = spawn(executable.command, [...executable.prefix, ...args], { cwd: session.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) { localRuns.delete(session.id); throw error; }
  let buffer = "", stderr = "", failure = "", resultSeen = false;
  const consume = (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const event = claudeEvent(row); if (event) onEvent(event);
      if (row.type === "result") {
        resultSeen = true;
        if (row.is_error) failure = (row.errors ?? []).join("\n") || row.result || "Claude 执行失败";
        else if (row.permission_denials?.length) failure = "Claude 的部分操作需要权限。请在手机运行设置调整权限，或回到电脑处理。";
      }
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-12_000); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
  let stopping = false;
  const completed = new Promise((resolve, reject) => {
    child.once("error", (error) => { localRuns.delete(session.id); reject(error); });
    child.once("close", (code) => {
      localRuns.delete(session.id);
      invalidateSessions();
      if (buffer.trim()) consume("\n");
      if (stopping) resolve({ stopped: true });
      else if (code !== 0 || failure || !resultSeen) reject(new Error(failure || stderr.trim() || "Claude 未返回完成结果，请查看会话后重试"));
      else resolve({ ok: true });
    });
  });
  void completed.catch(() => undefined);
  return { completed, supportsStop: true, stop() {
    stopping = true;
    if (child.exitCode !== null) return;
    if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    else child.kill("SIGTERM");
  } };
}
