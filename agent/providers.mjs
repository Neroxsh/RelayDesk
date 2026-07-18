import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_WINDOW_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-window.ps1");

function resolveOnWindows(name) {
  const script = `$c=Get-Command ${name} -ErrorAction Stop | Select-Object -First 1; $c.Source`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = result.stdout.trim();
  return found && fs.existsSync(found) ? found : null;
}

function providerExecutable(provider) {
  const name = provider === "codex" ? "codex" : "claude";
  if (process.platform !== "win32") return { command: name, prefix: [] };
  const found = resolveOnWindows(name);
  if (!found) throw new Error(`没有找到 ${name}，请先在电脑上安装并登录`);
  if (path.extname(found).toLowerCase() === ".ps1") {
    return {
      command: "powershell.exe",
      prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", found],
    };
  }
  return { command: found, prefix: [] };
}

function argsFor(session, mode) {
  if (session.provider === "codex") {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
    if (mode === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
    args.push(session.id, "-");
    return args;
  }
  const args = [
    "-p",
    "--resume",
    session.id,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    mode === "full" ? "bypassPermissions" : "dontAsk",
  ];
  if (mode === "full") args.push("--dangerously-skip-permissions");
  return args;
}

function summarize(provider, row) {
  if (provider === "codex") {
    if (row?.type === "item.completed" && row.item?.type === "agent_message") {
      return { type: "assistant", text: row.item.text ?? "" };
    }
    if (row?.type === "item.completed" && row.item?.type === "command_execution") {
      return { type: "tool", text: row.item.command ?? "命令已完成", status: row.item.status };
    }
    if (row?.type === "turn.failed" || row?.type === "error") {
      return { type: "error", text: row.error?.message ?? row.message ?? "Codex 执行失败" };
    }
    return null;
  }
  if (row?.type === "assistant") {
    const text = Array.isArray(row.message?.content)
      ? row.message.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n")
      : "";
    return text ? { type: "assistant", text } : null;
  }
  if (row?.type === "result" && row.is_error) return { type: "error", text: row.result ?? "Claude 执行失败" };
  return null;
}

export function sendPrompt(session, prompt, mode, onEvent) {
  const executable = providerExecutable(session.provider);
  const args = [...executable.prefix, ...argsFor(session, mode)];
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
  const child = spawn(executable.command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const consume = (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const summary = summarize(session.provider, JSON.parse(line));
        if (summary) onEvent(summary);
      } catch {
        onEvent({ type: "log", text: line.slice(0, 8_000) });
      }
    }
  };

  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 24_000) stderrBuffer = stderrBuffer.slice(-24_000);
  });
  child.stdin.end(prompt);

  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (stdoutBuffer.trim()) consume("\n");
      if (code === 0) resolve({ code, signal });
      else reject(new Error(stderrBuffer.trim() || `${session.provider} 已退出（${code ?? signal}）`));
    });
  });

  return {
    pid: child.pid,
    completed,
    stop() {
      if (child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    },
  };
}

export function sendToCurrentCodex(prompt) {
  if (process.platform !== "win32") throw new Error("当前 Codex 窗口控制只支持 Windows");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      CODEX_WINDOW_SCRIPT,
      "-PromptBase64",
      Buffer.from(prompt, "utf8").toString("base64"),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      let result = null;
      try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}"); } catch { /* use stderr below */ }
      if (code === 0 && result?.ok) resolve(result);
      else reject(new Error(result?.error ?? stderr.trim() ?? "无法把指令发送到当前 Codex 窗口"));
    });
  });
  return {
    pid: child.pid,
    completed,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}
