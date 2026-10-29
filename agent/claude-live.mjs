import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { claudeHome, activeClaudeSessions } from "./claude-sessions.mjs";
import { writeAtomicJson } from "./persistence.mjs";
import { interactions } from "./interactions.mjs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyClaudeProcess } from "./claude-process.mjs";

const connections = new Map();
const removed = new Set();
const execute = promisify(execFile);
const consoleChecks = new Map();
const connectionFile = () => path.join(process.env.RELAYDESK_STATE_DIR || path.join(os.homedir(), ".relaydesk"), "claude-live.json");
let saving = Promise.resolve();
async function loadConnection(id) {
  if (!connections.has(id)) {
    const saved = await readFile(connectionFile(), "utf8").then(JSON.parse).catch(() => ({}));
    if (saved[id]) connections.set(id, saved[id]);
  }
  return connections.get(id);
}
function saveConnections() {
  saving = saving.catch(() => undefined).then(async () => {
    const liveIds = new Set((await activeClaudeSessions()).map((s) => s.sessionId));
    const saved = await readFile(connectionFile(), "utf8").then(JSON.parse).catch(() => ({}));
    const rows = Object.fromEntries(Object.entries({ ...saved, ...Object.fromEntries(connections) }).filter(([id, row]) => !removed.has(id) && (liveIds.has(id) || Date.now() - row.at < 60000)));
    await writeAtomicJson(connectionFile(), rows);
  });
  return saving;
}
export function claudeHookSettings() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-hook.mjs");
  const hook = { type: "command", command: process.execPath, args: [script], onFailure: "continue", timeout: 560 };
  return { SessionStart: [{ hooks: [{ ...hook, timeout: 12 }] }], PermissionRequest: [{ hooks: [hook] }], PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }], SessionEnd: [{ hooks: [{ ...hook, timeout: 5 }] }] };
}
export async function installClaudeHooks() {
  const filename = path.join(claudeHome(), "settings.json");
  let settings;
  try { settings = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Claude 设置不可读，没有覆盖原设置"); settings = {}; }
  if (settings.disableAllHooks === true) throw new Error("Claude 当前禁用了全部 hooks，请先在电脑设置中启用 hooks，再安装手机连接");
  const hooks = { ...settings.hooks };
  for (const [event, entries] of Object.entries(claudeHookSettings())) {
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing)) throw new Error("Claude hooks 格式不兼容，没有修改设置");
    hooks[event] = [...existing.map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !h.command?.includes("claude-hook.mjs") && !h.args?.some((arg) => String(arg).endsWith("claude-hook.mjs"))) })).filter((entry) => entry.hooks.length), ...entries];
  }
  await writeAtomicJson(filename, { ...settings, hooks }, { backup: true });
  return { ok: true, restartRequired: true };
}
export async function handleClaudeHook(body, { mobileActive = () => false, signal } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(body.session_id ?? "")) throw new Error("Claude 会话 ID 无效");
  const id = body.session_id;
  if (body.hook_event_name === "SessionStart") {
    removed.delete(id);
    if (typeof body.socket === "string" && body.socket.length < 2000 && typeof body.token === "string" && body.token.length < 2000) { connections.set(id, { sessionId: id, socket: body.socket.replace(/^uds:/, ""), token: body.token, at: Date.now(), pid: body.claudePid, startedAt: body.startedAt, home: body.home || claudeHome(), kind: body.managed ? "sdk" : "interactive", permissionMode: body.permission_mode, model: body.model }); await saveConnections(); }
    return {};
  }
  if (body.hook_event_name === "SessionEnd") {
    const current = await loadConnection(id);
    if (body.connectionToken && current?.token && body.connectionToken !== current.token) return {};
    removed.add(id); connections.delete(id); interactions.cancelSession(id); await saveConnections(); return {};
  }
  const event = body.hook_event_name;
  if (!mobileActive(id) || !["PreToolUse", "PermissionRequest"].includes(event) || (event === "PreToolUse" && !["AskUserQuestion", "ExitPlanMode"].includes(body.tool_name))) return {};
  const requestId = `hook-${randomUUID()}`;
  const promise = interactions.ask({ id: requestId, sessionId: id, tool: body.tool_name, input: body.tool_input ?? {} });
  const abort = () => interactions.finish(requestId, null); signal?.addEventListener("abort", abort, { once: true });
  try {
    const decision = await promise;
    if (!decision) return {};
    if (event === "PermissionRequest") return { output: { hookSpecificOutput: { hookEventName: event, decision } } };
    // Answer the interactive tools through their documented updatedInput fields.
    return { output: { hookSpecificOutput: { hookEventName: event, permissionDecision: decision.behavior, updatedInput: decision.updatedInput, permissionDecisionReason: decision.message } } };
  } finally { signal?.removeEventListener("abort", abort); }
}
export async function claudeLiveStatus(id) {
  const live = (await activeClaudeSessions()).find((s) => s.sessionId === id);
  const connection = await loadConnection(id);
  if (!live) { connections.delete(id); return null; }
  const canStop = connection && process.platform === "win32" && connection.pid && await terminalKey(connection, "probe");
  return { available: Boolean(connection), canSend: Boolean(connection), canStop: Boolean(canStop), canSetPermissions: false, pending: interactions.list(id), source: "claude-terminal",
    reason: connection ? "连接电脑原 Claude 进程；发送后会在当前工具调用结束后处理。" : "此终端尚未连接手机控制。请在电脑退出并重新运行 claude --resume，恢复同一会话后即可连接。" };
}
async function terminalKey(connection, action) {
  if (process.platform !== "win32" || !Number.isSafeInteger(connection.pid) || !Number.isFinite(connection.startedAt)) return false;
  const cached = consoleChecks.get(connection.pid);
  if (action === "probe" && cached && Date.now() - cached.at < 30000) return cached.ok;
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-console.ps1"), "-ClaudePid", String(connection.pid), "-StartedAt", String(Math.trunc(connection.startedAt)), "-Action", action], { windowsHide: true, timeout: 8000 });
    const ok = JSON.parse(stdout).ok === true; if (action === "probe") consoleChecks.set(connection.pid, { at: Date.now(), ok }); return ok;
  } catch { return false; }
}
export async function stopClaudeLive(id) {
  const connection = await loadConnection(id);
  if (!connection || !await terminalKey(connection, "escape")) throw new Error("这个终端没有可用的停止连接，请在电脑按 Esc");
  return { ok: true };
}
export async function sendClaudeLive(session, prompt) {
  const active = (await activeClaudeSessions()).filter((s) => s.sessionId === session.id);
  if (active.length !== 1) throw new Error("无法确定唯一的 Claude 原进程，请刷新会话");
  const connection = await loadConnection(session.id);
  if (!connection) throw new Error("请在电脑重新打开此 Claude 会话，以启用手机接入");
  if (connection.pid && !await verifyClaudeProcess(connection.pid, connection.startedAt)) throw new Error("Claude 原进程已变化，请重新打开会话连接");
  const uuid = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socket); let dispatched = false;
    const fail = () => { const error = new Error(dispatched ? "Claude 消息已写入原进程，暂未确认；请查看会话，避免重复发送" : "Claude 原进程连接失败，请刷新"); error.code = dispatched ? "DELIVERY_UNCERTAIN" : "CLAUDE_UNAVAILABLE"; reject(error); socket.destroy(); };
    const timer = setTimeout(fail, 5000);
    socket.once("error", () => { clearTimeout(timer); fail(); });
    socket.once("connect", () => {
      dispatched = true;
      socket.end(`${JSON.stringify({ type: "auth", token: connection.token })}\n${JSON.stringify({ type: "user", session_id: session.id, uuid, from: "RelayDesk", message: { role: "user", content: prompt } })}\n`, () => { clearTimeout(timer); resolve({ ok: true, uuid }); socket.destroy(); });
    });
  });
}
