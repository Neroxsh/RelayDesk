import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_WINDOW_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-window.ps1");
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_DEEPLINK_SETTLE_MS = 1_400;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function codexThreadUrl(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!CODEX_THREAD_ID.test(id)) throw new Error("Codex 会话 ID 无效");
  return `codex://threads/${id}`;
}

function resolveOnWindows(name) {
  const script = `$all=Get-Command ${name} -All -ErrorAction Stop; ` +
    `$c=$all | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -like '*.cmd' } | Select-Object -First 1; ` +
    `if(-not $c){$c=$all | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -like '*.exe' } | Select-Object -First 1}; ` +
    `if(-not $c){$c=$all | Select-Object -First 1}; $c.Source`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = result.stdout.trim();
  return found && fs.existsSync(found) ? found : null;
}

export function codexExecutable() {
  const name = "codex";
  if (process.platform !== "win32") return { command: name, prefix: [] };
  const found = resolveOnWindows(name);
  if (!found) throw new Error(`没有找到 ${name}，请先在电脑上安装并登录`);
  if (path.extname(found).toLowerCase() === ".cmd") {
    return {
      command: "cmd.exe",
      prefix: ["/d", "/s", "/c", found],
    };
  }
  if (path.extname(found).toLowerCase() === ".ps1") {
    return {
      command: "powershell.exe",
      prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", found],
    };
  }
  return { command: found, prefix: [] };
}

function quotedConfig(value) {
  return JSON.stringify(String(value));
}

function argsFor(session, settings = {}) {
  const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
  const permission = ["read-only", "workspace", "full"].includes(settings.permission)
    ? settings.permission
    : "workspace";
  if (permission === "full") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", permission === "read-only" ? "read-only" : "workspace-write");
    args.push("--ask-for-approval", "never");
  }
  if (settings.model && /^[\w.:-]{1,100}$/.test(settings.model)) args.push("--model", settings.model);
  if (settings.reasoning && /^[\w-]{1,32}$/.test(settings.reasoning)) {
    args.push("--config", `model_reasoning_effort=${quotedConfig(settings.reasoning)}`);
  }
  if (settings.serviceTier && /^[\w-]{1,32}$/.test(settings.serviceTier)) {
    args.push("--config", `service_tier=${quotedConfig(settings.serviceTier)}`);
  }
  args.push(session.id, "-");
  return args;
}

function summarize(row) {
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

export function sendPrompt(session, prompt, settings, onEvent) {
  if (session.provider !== "codex") throw new Error("当前版本仅支持 Codex");
  const executable = codexExecutable();
  const args = [...executable.prefix, ...argsFor(session, settings)];
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
        const summary = summarize(JSON.parse(line));
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
      else reject(new Error(stderrBuffer.trim() || `Codex 已退出（${code ?? signal}）`));
    });
  });
  void completed.catch(() => undefined);

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
  void completed.catch(() => undefined);
  return {
    pid: child.pid,
    completed,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}

export function openCodexSession(sessionId) {
  const url = codexThreadUrl(sessionId);
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`]
    : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ ok: true, url });
      else reject(new Error(stderr.trim() || "无法打开 Codex 桌面会话"));
    });
  });
  void completed.catch(() => undefined);
  return {
    pid: child.pid,
    completed,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}

export function sendToCodexSession(sessionId, prompt) {
  const navigation = openCodexSession(sessionId);
  let injection = null;
  let stopped = false;
  const completed = (async () => {
    await navigation.completed;
    await wait(CODEX_DEEPLINK_SETTLE_MS);
    if (stopped) throw new Error("发送已停止");
    injection = sendToCurrentCodex(prompt);
    return injection.completed;
  })();
  void completed.catch(() => undefined);
  return {
    pid: navigation.pid,
    completed,
    stop() {
      stopped = true;
      navigation.stop();
      injection?.stop();
    },
  };
}
