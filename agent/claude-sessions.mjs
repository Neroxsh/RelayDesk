import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "./persistence.mjs";

let configuredHome = "";
export const claudeHome = () => configuredHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export function configureClaudeHome(home = "") { configuredHome = home; }
const registryFile = () => path.join(process.env.RELAYDESK_STATE_DIR || path.join(os.homedir(), ".relaydesk"), "claude-sessions.json");
async function registry(strict = false) {
  try {
    const rows = JSON.parse(await readFile(registryFile(), "utf8"));
    if (!Array.isArray(rows) || rows.some((row) => !row?.id || row.provider !== "claude" || typeof row.cwd !== "string")) throw new Error("invalid registry");
    return rows;
  }
  catch (error) { if (!strict || error.code === "ENOENT") return []; throw new Error("Claude 待发送会话记录不可读，请先修复本机记录"); }
}
export async function activeClaudeSessions() {
  const directory = path.join(claudeHome(), "sessions");
  const files = await readdir(directory).catch(() => []);
  const rows = await Promise.all(files.filter((file) => /^\d+\.json$/.test(file)).map(async (file) => {
    try { const row = JSON.parse(await readFile(path.join(directory, file), "utf8")); process.kill(row.pid, 0); return row; }
    catch { return null; }
  }));
  const result = rows.filter(Boolean);
  // New CLI storage revisions may no longer mirror every -p process into the
  // legacy sessions directory. SessionStart supplies a separate local registry.
  const captured = await readFile(path.join(process.env.RELAYDESK_STATE_DIR || path.join(os.homedir(), ".relaydesk"), "claude-live.json"), "utf8").then(JSON.parse).catch(() => ({}));
  for (const row of Object.values(captured)) {
    if (!row?.pid || path.resolve(row.home || claudeHome()) !== path.resolve(claudeHome()) || result.some((s) => s.pid === row.pid)) continue;
    try { process.kill(row.pid, 0); result.push(row); } catch { /* Ended process. */ }
  }
  return result;
}
export async function createClaudeSession(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("请选择电脑上存在的项目绝对路径");
  const id = randomUUID();
  const session = { id, key: `claude:${id}`, provider: "claude", title: "新的 Claude Code 会话", cwd, projectPath: cwd, projectName: path.basename(cwd), updatedAt: Date.now(), isNew: true };
  const rows = await registry(true);
  await writeAtomicJson(registryFile(), [...rows, session].slice(-100), { backup: true });
  return session;
}
export async function pendingClaudeSessions() { return registry(); }

export function parseClaudeTranscript(rows) {
  const messages = [];
  const activity = [];
  let settings;
  let permission = "workspace";
  for (const row of rows) {
    if (row.isSidechain) continue;
    const mode = row.permissionMode ?? (row.type === "permission-mode" ? row.permissionMode : null);
    if (mode) permission = mode === "bypassPermissions" ? "full" : mode === "plan" ? "read-only" : mode === "default" ? "ask" : "workspace";
    if (row.type !== "user" && row.type !== "assistant") continue;
    const content = row.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    let text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    const relayPeer = row.type === "user" && row.origin?.kind === "peer" && row.origin?.from === "RelayDesk";
    if (relayPeer) text = text.replace(/^Another Claude session sent a message:\n/, "").split("\n\nThis came from another Claude session")[0];
    if (text && (!row.isMeta || relayPeer) && !/^\s*<(?:local-command|command-name|system-reminder)/.test(text)) messages.push({
      id: row.uuid ?? `${row.timestamp}-${row.type}-${messages.length}`, role: row.type === "user" ? "user" : "assistant", content: text.slice(0, 120_000), timestamp: row.timestamp ?? null,
    });
    if (row.type === "assistant" && row.message?.model && row.message.model !== "<synthetic>") settings = {
      model: row.message.model, reasoning: "", permission, serviceTier: "", source: "session",
    };
    for (const block of blocks) {
      if (block.type === "tool_use") activity.push({ id: block.id, label: `调用 ${block.name}`, status: "running", timestamp: row.timestamp });
      if (block.type === "tool_result") { const item = activity.find((item) => item.id === block.tool_use_id); if (item) { item.status = block.is_error ? "failed" : "completed"; item.label = item.label.replace("调用", "已调用"); } }
    }
  }
  return { messages, activity: activity.slice(-40), state: "idle", settings };
}
