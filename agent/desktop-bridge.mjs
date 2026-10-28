import { readdir } from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const catalogs = new Map();

export class DesktopDeliveryError extends Error {
  constructor(message, code, dispatched = false) {
    super(message);
    this.code = code;
    this.dispatched = dispatched;
  }
}

async function desktopPipe() {
  const configured = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
  if (configured && process.platform !== "win32") return configured;
  if (process.platform !== "win32") throw new Error("桌面会话接口仅支持 Windows");
  const pipes = (await readdir("\\\\.\\pipe\\")).filter((name) => name.startsWith("codex-app-tools-"));
  if (configured && pipes.some((name) => configured.endsWith(`\\${name}`))) return configured;
  if (pipes.length !== 1) throw new Error("无法确定 Codex 桌面连接，请打开一个 Codex 桌面实例后重试");
  return `\\\\.\\pipe\\${pipes[0]}`;
}

export function pipeRequest(pipePath, method, params, { signal, timeoutMs = 8_000, onDispatched } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let dispatched = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DesktopDeliveryError("已停止等待桌面确认", "CANCELLED", dispatched));
    const timer = setTimeout(() => finish(new DesktopDeliveryError(
      dispatched ? "桌面仍在确认消息，正在核实送达状态，请勿重复发送" : "暂时无法连接 Codex 桌面",
      dispatched ? "DELIVERY_UNCERTAIN" : "DESKTOP_UNAVAILABLE", dispatched,
    )), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.once("connect", () => {
      const payload = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
      if (payload.length > MAX_FRAME_BYTES) { finish(new Error("桌面请求过大")); return; }
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      dispatched = true;
      socket.write(frame);
      onDispatched?.();
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) { finish(new Error("桌面响应过大")); return; }
      if (buffer.length < length + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4);
        if (response.id !== 1) continue;
        if (response.jsonrpc !== "2.0") throw new Error("Codex 桌面响应无效");
        finish(response.error ? new Error(response.error.message ?? "Codex 桌面请求失败") : null, response.result);
        return;
      } catch (error) { finish(error); return; }
      }
    });
    socket.once("error", (error) => finish(new DesktopDeliveryError(`Codex 桌面连接失败：${error.message}`, dispatched ? "DELIVERY_UNCERTAIN" : "DESKTOP_UNAVAILABLE", dispatched)));
    socket.once("close", () => finish(new DesktopDeliveryError("Codex 桌面连接已关闭", dispatched ? "DELIVERY_UNCERTAIN" : "DESKTOP_UNAVAILABLE", dispatched)));
  });
}

async function desktopCatalog(pipePath, options = {}) {
  const cached = catalogs.get(pipePath);
  if (cached && Date.now() - cached.at < 60_000) return cached.promise;
  const promise = pipeRequest(pipePath, "tools/list", { threadStartKind: "all" }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 8_000 });
  catalogs.set(pipePath, { at: Date.now(), promise });
  if (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value);
  try { return await promise; } catch (error) { catalogs.delete(pipePath); throw error; }
}

async function callDesktop(sessionId, toolName, args, options = {}) {
  if (!THREAD_ID.test(String(sessionId ?? ""))) throw new Error("Codex 会话 ID 无效");
  const pipePath = options.pipePath ?? await desktopPipe();
  let catalog;
  try { catalog = await desktopCatalog(pipePath, options); }
  catch (error) {
    if (error.code === "CANCELLED") throw error;
    throw new DesktopDeliveryError("暂时无法连接 Codex 桌面，消息尚未提交", "DESKTOP_UNAVAILABLE", false);
  }
  const tool = catalog?.tools?.find((item) => item.name === toolName);
  if (!tool) throw new Error("当前 Codex 桌面版本不支持会话发送接口");
  const result = await pipeRequest(pipePath, "tools/call", {
    arguments: args,
    callerSource: "codex",
    hostId: "local",
    namespace: tool.namespace,
    threadId: sessionId,
    tool: tool.name,
    callId: `relaydesk-${randomUUID()}`,
    turnId: `relaydesk-${randomUUID()}`,
  }, { ...options, timeoutMs: options.timeoutMs ?? (toolName === "send_message_to_thread" ? 90_000 : 12_000) });
  if (!result?.success) {
    const message = result?.contentItems?.filter((item) => item.type === "inputText").map((item) => item.text).join("\n");
    throw new Error(message || "Codex 桌面未接受这条消息");
  }
  let data = null;
  for (const item of result.contentItems ?? []) {
    if (item.type !== "inputText") continue;
    try { data = JSON.parse(item.text); break; } catch { /* Some app versions return plain acknowledgements. */ }
  }
  return { ok: true, data };
}

export async function probeDesktopBridge(sessionId, options) {
  await callDesktop(sessionId, "read_thread", {
    threadId: sessionId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0,
  }, options);
  return { ok: true };
}

export async function getDesktopCapabilities(sessionId, options = {}) {
  const pipePath = options.pipePath ?? await desktopPipe();
  const catalog = await desktopCatalog(pipePath, options);
  const description = catalog.tools?.find((tool) => tool.name === "send_message_to_thread")?.inputSchema?.properties?.model?.description ?? "";
  const models = [...description.matchAll(/([a-z][\w.-]+)\s*\(([^;]+);\s*supported reasoning efforts:\s*([^)]+)\)/gi)].map((match) => ({
    id: match[1], model: match[1], displayName: match[1], description: match[2].trim(), isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: match[3].split(",").map((value) => ({ reasoningEffort: value.trim() })),
    serviceTiers: [], defaultServiceTier: null,
  }));
  const { data } = await callDesktop(sessionId, "get_usage_limits", {}, { ...options, pipePath });
  return { models, limits: data, source: "desktop" };
}

export function sendDesktopPrompt(sessionId, prompt, options = {}) {
  const controller = new AbortController();
  let finished = false;
  let confirmPromise;
  const completed = (async () => {
    const settings = options.settings ?? {};
    const request = callDesktop(sessionId, "send_message_to_thread", {
      threadId: sessionId, hostId: "local", prompt,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoning ? { thinking: settings.reasoning } : {}),
    }, { ...options, signal: controller.signal, onDispatched() {
      options.onDispatched?.();
      if (options.confirmDelivery) confirmPromise = (async () => {
        const deadline = Date.now() + (options.timeoutMs ?? 90_000);
        while (!finished && !controller.signal.aborted && Date.now() < deadline) {
          if (await options.confirmDelivery().catch(() => false)) return { ok: true, confirmedBy: "transcript" };
          await new Promise((resolve) => setTimeout(resolve, options.confirmIntervalMs ?? 1_000));
        }
        // The original request supplies the authoritative error if neither path confirms.
        return request;
      })();
    } });
    // Do not dispatch a second message when an acknowledgement is delayed.
    const observed = (async () => {
      while (!confirmPromise && !finished && !controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 25));
      return confirmPromise ?? request;
    })();
    try {
      const result = await Promise.race([request, observed]);
      return result.confirmedBy ? result : { ok: true };
    } finally { finished = true; controller.abort(); }
  })();
  void completed.catch(() => undefined);
  return { completed, supportsStop: false, stop() { controller.abort(); } };
}
