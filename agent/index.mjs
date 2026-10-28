import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, randomToken, sha256 } from "./crypto.mjs";
import {
  configureSessionRoots,
  getSession,
  invalidateSessions,
  listSessions,
  normalizeProviderHome,
  sessionDiagnostics,
} from "./sessions.mjs";
import { openCodexSession, sendPrompt, sendToCodexSession, sendToCurrentCodex } from "./providers.mjs";
import { getCodexStatus } from "./codex-status.mjs";
import { CONTROL_URL, openControlPanel, startControlServer } from "./control-server.mjs";
import { mergeTimelineMessages } from "./messages.mjs";
import { writeAtomicJson } from "./persistence.mjs";
import { RequestLedger } from "./request-ledger.mjs";
import { sendClaudePrompt } from "./claude-runner.mjs";
import { createClaudeSession } from "./claude-sessions.mjs";
import { getClaudeStatus, getClaudeCapabilities, switchGlobalProvider } from "./claude-status.mjs";

const CONFIG_DIR = path.join(os.homedir(), ".relaydesk");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const LOCK_PATH = path.join(CONFIG_DIR, "agent.lock");
const command = process.argv[2] ?? "start";
const DEFAULT_RELAY = "https://relay.xingshihao.site";
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

let configWrite = Promise.resolve();

function saveConfig(config) {
  const snapshot = JSON.parse(JSON.stringify(config));
  configWrite = configWrite.catch(() => undefined).then(() => writeAtomicJson(CONFIG_PATH, snapshot, { backup: true }));
  return configWrite;
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireAgentLock() {
  await mkdir(CONFIG_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      const release = () => {
        try {
          if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH);
        } catch {
          // The next launch removes a stale lock after an unclean shutdown.
        }
      };
      process.once("exit", release);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number.parseInt(await readFile(LOCK_PATH, "utf8").catch(() => ""), 10);
      if (processIsRunning(owner)) return false;
      await unlink(LOCK_PATH).catch(() => undefined);
    }
  }
  return false;
}

function createPairKey() {
  const raw = randomBytes(16);
  const text = [...raw].map((byte) => PAIR_ALPHABET[byte % PAIR_ALPHABET.length]).join("");
  return text.match(/.{1,4}/g).join("-");
}

function normalizePairKey(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}

async function loadConfig() {
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try {
        const recovered = JSON.parse(await readFile(`${CONFIG_PATH}.bak`, "utf8"));
        if (!recovered.deviceId || !recovered.keys?.privateKey || !recovered.agentToken) throw new Error("备份无效");
        await writeAtomicJson(CONFIG_PATH, recovered);
        console.error("配置损坏，已从有效备份恢复设备身份和手机绑定。");
        return recovered;
      } catch { throw new Error("设备配置和备份不可读，请在电脑端恢复配置；不会自动清除手机绑定。"); }
    }
    const keys = await generateDeviceKeys();
    config = {
      version: 2,
      relayUrl: "",
      siteToken: "",
      deviceId: `device_${randomToken(12)}`,
      agentToken: randomToken(32),
      deviceName: os.hostname(),
      keys,
      pairKey: createPairKey(),
      controlToken: randomToken(24),
      clients: {},
      pendingPairs: {},
      cursor: 0,
    };
  }
  let changed = false;
  if (!config.pairKey) { config.pairKey = createPairKey(); changed = true; }
  if (!config.controlToken) { config.controlToken = randomToken(24); changed = true; }
  if (!config.pendingPairs) { config.pendingPairs = {}; changed = true; }
  if (!config.clients) { config.clients = {}; changed = true; }
  if (config.version !== 2) { config.version = 2; changed = true; }
  if (!config.createdAt) { config.createdAt = Date.now(); changed = true; }
  if (changed) await saveConfig(config);
  return config;
}

function normalizeRelay(value) {
  return String(value ?? "").trim().replace(/\/+$/g, "");
}

async function request(config, pathname, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(config.siteToken ? { "OAI-Sites-Authorization": `Bearer ${config.siteToken}` } : {}),
    ...(options.auth === false ? {} : { authorization: `Bearer ${config.agentToken}` }),
    "x-relaydesk-device-id": config.deviceId,
    ...(options.headers ?? {}),
  };
  const fetchOptions = { ...options };
  delete fetchOptions.auth;
  const response = await fetch(`${config.relayUrl}${pathname}`, {
    ...fetchOptions,
    headers,
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  const status = response.status;
  const responseBody = await response.text();
  let data = {};
  try {
    data = responseBody ? JSON.parse(responseBody) : {};
  } catch {
    // Preserve a useful status error when a gateway returns HTML.
    if (status >= 200 && status < 300) throw new Error("中继返回了无效响应，正在重新连接");
  }
  if (status < 200 || status >= 300) {
    const error = new Error(data.error ?? `中继服务返回 ${status}`);
    error.status = status;
    throw error;
  }
  return data;
}

async function register(config) {
  await request(config, "/api/device/register", {
    method: "POST",
    auth: false,
    body: JSON.stringify({
      deviceId: config.deviceId,
      agentToken: config.agentToken,
      name: config.deviceName,
      platform: `${process.platform} ${os.release()}`,
      publicKey: config.keys.publicKey,
      pairKeyHash: sha256(normalizePairKey(config.pairKey)),
    }),
  });
}

const keyCache = new Map();
const clientActivity = new Map();

async function clientKey(config, clientId) {
  if (keyCache.has(clientId)) return keyCache.get(clientId);
  const client = config.clients[clientId];
  if (!client) throw new Error("未知手机设备");
  const key = await deriveSessionKey(config.keys.privateKey, client.publicKey, client.saltHash ?? client.codeHash);
  keyCache.set(clientId, key);
  return key;
}

async function send(config, clientId, payload) {
  const key = await clientKey(config, clientId);
  const delivery = { eventId: randomToken(12), at: Date.now(), ...payload };
  const envelope = await encryptJson(key, delivery);
  await request(config, "/api/agent/send", {
    method: "POST",
    body: JSON.stringify({ clientId, envelope, deliveryId: delivery.eventId }),
  });
  const previous = clientActivity.get(clientId) ?? {};
  clientActivity.set(clientId, {
    ...previous,
    lastDeliveredAt: Date.now(),
    lastDeliveredType: payload?.type ?? "unknown",
  });
}

const activeRuns = new Map();
const subscriptions = new Map();
const stableSnapshots = new Map();
const handledRequests = new RequestLedger(path.join(CONFIG_DIR, "requests.json"));
let lastSessionSignature = "";
let lastExternalSyncAt = 0;
let activeCodexSessionId = null;
let claudeLaunches = 0;
let switchingClaudeProvider = false;
async function startClaudeRun(session, prompt, settings, onEvent) {
  if (switchingClaudeProvider) throw new Error("全局供应商正在切换，请等待确认后发送");
  claudeLaunches += 1;
  try {
    const run = await sendClaudePrompt(session, prompt, settings, onEvent);
    activeRuns.set(session.key, run);
    return run;
  } finally { claudeLaunches -= 1; }
}
const SUBSCRIPTION_TTL = 45_000;
const ACTIVE_CLIENT_TTL = 90_000;

function stableSessionSnapshot(session) {
  const previous = stableSnapshots.get(session.key);
  const changedCurrentSession = Boolean(
    previous?.currentWindow
    && session.currentWindow
    && previous.sourceSessionId !== session.sourceSessionId,
  );
  if (!previous || changedCurrentSession) {
    stableSnapshots.set(session.key, session);
    return session;
  }
  const messages = mergeTimelineMessages(previous.messages ?? [], session.messages ?? []);
  const merged = { ...previous, ...session, messages };
  stableSnapshots.set(session.key, merged);
  return merged;
}

function isRelayTimeout(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /aborted|aborterror|timeout|timed out|中继服务返回\s*5\d\d|relay[^\n]*\s5\d\d/i.test(message);
}

function userFacingError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/GetCurrentPattern|AutomationElement|element is not available/i.test(message)) {
    return "Codex 输入框刚刚刷新，请再试一次";
  }
  if (isRelayTimeout(error)) return "连接短暂超时，请再试一次";
  const clean = message.replace(/[\u0000-\u001f]+/g, " ").trim();
  return clean && clean.length <= 180 ? clean : "电脑端暂时无法完成这次操作";
}

async function sendBestEffort(config, clientId, payload) {
  const delivery = { eventId: randomToken(12), at: Date.now(), ...payload };
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await send(config, clientId, delivery);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  console.error(`状态回传失败：${lastError instanceof Error ? lastError.message : lastError}`);
  return false;
}

async function claimMutatingRequest(clientId, payload) {
  return handledRequests.claim(clientId, payload);
}

async function rememberRequestResponse(clientId, requestId, response) {
  if (!requestId) return;
  await handledRequests.remember(clientId, requestId, response);
}

async function sendRequestResponse(config, clientId, requestId, response) {
  response = { ...response, at: Date.now() };
  await rememberRequestResponse(clientId, requestId, response);
  if (response.type === "run:status" || response.type === "request:error") {
    const activity = clientActivity.get(clientId) ?? {};
    clientActivity.set(clientId, {
      ...activity,
      lastRun: { requestId, sessionKey: response.sessionKey, status: response.status ?? "failed", error: response.error, at: Date.now() },
    });
    if (response.error) console.error(`[${new Date().toISOString()}] 任务发送失败：${response.error}`);
  }
  return sendBestEffort(config, clientId, response);
}

async function publicSessions() {
  const source = await listSessions();
  const latestCodex = source.find((session) => session.provider === "codex");
  const currentCodex = source.find((session) => session.provider === "codex" && session.id === activeCodexSessionId)
    ?? latestCodex;
  const sessions = source.map((session) => {
    const result = {
      ...session,
      active: activeRuns.has(session.key),
      openInCodex: session.provider === "codex" && session.id === currentCodex?.id,
    };
    delete result.filePath;
    return result;
  });
  sessions.unshift({
    id: "__current__",
    key: "codex:__current__",
    provider: "codex",
    title: "继续上次会话",
    cwd: currentCodex?.cwd ?? "",
    projectName: "当前窗口",
    updatedAt: currentCodex?.updatedAt ?? Date.now(),
    recent: true,
    active: activeRuns.has("codex:__current__"),
    currentWindow: true,
  });
  return sessions;
}

async function currentCodexDetail() {
  const source = await listSessions(true);
  const latest = source.find((session) => session.provider === "codex");
  const current = source.find((session) => session.provider === "codex" && session.id === activeCodexSessionId)
    ?? latest;
  const detail = current ? await getSession("codex", current.id) : { messages: [] };
  return {
    ...detail,
    id: "__current__",
    key: "codex:__current__",
    provider: "codex",
    title: "继续上次会话",
    currentWindow: true,
    sourceSessionId: current?.id ?? null,
  };
}

async function sessionDetail(provider, sessionId) {
  if (!["codex", "claude"].includes(provider)) throw new Error("不支持的会话类型");
  const session = await (provider === "codex" && sessionId === "__current__"
    ? currentCodexDetail()
    : getSession(provider, sessionId));
  return stableSessionSnapshot(session);
}

function runSettings(payload) {
  const source = payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
  const permission = ["read-only", "workspace", "full"].includes(source.permission)
    ? source.permission
    : payload?.mode === "full" ? "full" : "workspace";
  return {
    permission,
    model: typeof source.model === "string" ? source.model : "",
    reasoning: typeof source.reasoning === "string" ? source.reasoning : "",
    serviceTier: typeof source.serviceTier === "string" ? source.serviceTier : "",
  };
}

async function watchSession(config, clientId, session) {
  const watch = {
    key: session.key,
    provider: session.provider,
    sessionId: session.id,
  };
  subscriptions.set(clientId, { ...watch, refreshedAt: Date.now() });
  const client = config.clients[clientId];
  if (client && (client.watch?.key !== watch.key || client.watch?.sessionId !== watch.sessionId)) {
    client.watch = watch;
    await saveConfig(config);
  }
}

async function handleCommand(config, clientId, payload) {
  const requestId = payload?.requestId ?? randomToken(8);
  const previousActivity = clientActivity.get(clientId) ?? {};
  clientActivity.set(clientId, {
    ...previousActivity,
    lastRequestAt: Date.now(),
    lastRequestType: payload?.type ?? "unknown",
  });
  try {
    if (payload?.type === "claude:status:get") {
      await sendBestEffort(config, clientId, { type: "claude:status", status: await getClaudeStatus() });
      return;
    }
    if (payload?.type === "ccswitch:switch") {
      if (switchingClaudeProvider || claudeLaunches || [...activeRuns.keys()].some((key) => key.startsWith("claude:"))) throw new Error("请先等待 Claude 任务结束，再切换全局供应商");
      switchingClaudeProvider = true;
      try {
        const status = await switchGlobalProvider(String(payload.providerId ?? ""));
        await sendRequestResponse(config, clientId, requestId, { type: "claude:status", status, switched: true });
      } finally { switchingClaudeProvider = false; }
      return;
    }
    if (payload?.type === "claude:create") {
      const capabilities = await getClaudeCapabilities();
      if (!capabilities.newSession) throw new Error("当前 Claude 版本不支持手机新建会话，请先升级");
      const session = await createClaudeSession(payload.cwd);
      invalidateSessions();
      await sendRequestResponse(config, clientId, requestId, { type: "session:created", session });
      await sendBestEffort(config, clientId, { type: "sessions:snapshot", sessions: await publicSessions() });
      return;
    }
    if (payload?.type === "sessions:ack") {
      clientActivity.set(clientId, {
        ...(clientActivity.get(clientId) ?? {}),
        lastAcknowledgedAt: Date.now(),
        acknowledgedSessions: Math.max(0, Number(payload.count) || 0),
      });
      return;
    }
    if (payload?.type === "ping") {
      await send(config, clientId, { type: "pong", requestId, at: Date.now() });
      return;
    }
    if (payload?.type === "request:status") {
      const saved = handledRequests.get(clientId, String(payload.originalRequestId ?? ""));
      await sendBestEffort(config, clientId, saved ?? {
        type: "request:unknown", requestId: payload.originalRequestId, sessionKey: payload.sessionKey,
      });
      return;
    }
    if (payload?.type === "codex:status:get") {
      const status = await getCodexStatus(Boolean(payload.refresh));
      await send(config, clientId, { type: "codex:status", requestId, status });
      return;
    }
    if (payload?.type === "sessions:list") {
      if (!payload.background) await sendBestEffort(config, clientId, { type: "sessions:loading", requestId, progress: 12, label: "正在读取 Codex 会话" });
      const sessions = await publicSessions();
      if (!payload.background) await sendBestEffort(config, clientId, { type: "sessions:loading", requestId, progress: 86, label: "正在整理项目" });
      await send(config, clientId, { type: "sessions:snapshot", requestId, sessions });
      void getClaudeStatus().then((status) => sendBestEffort(config, clientId, { type: "claude:status", status })).catch(() => undefined);
      void getCodexStatus().then((status) => sendBestEffort(config, clientId, {
        type: "codex:status",
        requestId,
        status,
      })).catch((error) => sendBestEffort(config, clientId, { type: "codex:status:error", error: userFacingError(error) }));
      return;
    }
    if (["session:get", "session:watch"].includes(payload?.type)) {
      const session = await sessionDetail(payload.provider, payload.sessionId);
      await watchSession(config, clientId, session);
      await send(config, clientId, { type: "session:snapshot", requestId, session });
      return;
    }
    if (payload?.type === "session:activate") {
      if (payload.provider !== "codex") throw new Error("这个会话不支持在 Codex 桌面端打开");
      const session = await getSession("codex", payload.sessionId);
      const navigation = openCodexSession(session.id);
      await navigation.completed;
      activeCodexSessionId = session.id;
      await sendBestEffort(config, clientId, {
        type: "session:activated",
        requestId,
        sessionKey: session.key,
      });
      await sendBestEffort(config, clientId, {
        type: "sessions:snapshot",
        requestId,
        sessions: await publicSessions(),
      });
      return;
    }
    if (payload?.type === "session:stop") {
      const key = `${payload.provider}:${payload.sessionId}`;
      const run = activeRuns.get(key);
      if (!run) throw new Error("这个会话当前没有正在执行的任务");
      if (run.supportsStop === false) throw new Error("桌面会话接口暂不支持中断任务，请在 Codex 电脑端停止");
      run.stop();
      await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "stopping" });
      return;
    }
    if (payload?.type === "session:send") {
      const prompt = String(payload.prompt ?? "").trim();
      if (!prompt || prompt.length > 12_000) throw new Error("指令需为 1–12000 个字符");
      if (!["codex", "claude"].includes(payload.provider)) throw new Error("不支持的会话类型");
      const settings = runSettings(payload);
      if (payload.provider === "codex" && process.platform === "win32" && payload.settings) {
        const status = await getCodexStatus();
        const model = status.models.find((item) => item.model === settings.model);
        if (settings.model && !model) throw new Error("电脑当前不支持所选模型，请刷新模型列表");
        if (settings.reasoning && model && !model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === settings.reasoning)) throw new Error("这个模型不支持所选思考强度");
      }
      const sentAt = Date.now();
      const desktopOptions = (sessionId) => ({
        settings: payload.settings ? settings : {},
        async confirmDelivery() {
          const detail = await getSession("codex", sessionId);
          return detail.messages.some((message) => message.role === "user" && message.content === prompt && Date.parse(message.timestamp ?? "") >= sentAt - 2_000);
        },
      });
      if (payload.provider === "codex" && payload.sessionId === "__current__") {
        const key = "codex:__current__";
        await watchSession(config, clientId, { key, provider: "codex", id: "__current__" });
        if (activeRuns.has(key)) throw new Error("正在把上一条指令发送到 Codex");
        const current = await currentCodexDetail();
        const source = current?.sourceSessionId ? await getSession("codex", current.sourceSessionId) : null;
        if (!source) throw new Error("还没有可继续的 Codex 会话");
        const run = process.platform === "win32"
          ? sendToCurrentCodex(prompt, source.id, desktopOptions(source.id))
          : sendPrompt(source, prompt, settings, (event) => {
            void send(config, clientId, { type: "run:event", requestId, sessionKey: key, event, at: Date.now() }).catch(() => undefined);
          });
        activeRuns.set(key, run);
        void sendRequestResponse(config, clientId, requestId, {
          type: "run:status",
          requestId,
          sessionKey: key,
          status: "running",
          mode: process.platform === "win32" ? "window" : "managed",
        });
        try {
          await run.completed;
        } catch (error) {
          await sendRequestResponse(config, clientId, requestId, {
            type: "run:status",
            requestId,
            sessionKey: key,
            status: error?.code === "DELIVERY_UNCERTAIN" ? "uncertain" : "failed",
            error: userFacingError(error),
          });
          return;
        } finally {
          activeRuns.delete(key);
          invalidateSessions();
        }
        await sendRequestResponse(config, clientId, requestId, { type: "run:status", requestId, sessionKey: key, status: "submitted" });
        return;
      }
      const session = await getSession(payload.provider, payload.sessionId);
      const key = `${session.provider}:${session.id}`;
      await watchSession(config, clientId, session);
      if (activeRuns.has(key)) throw new Error("这个会话仍在执行，请等待或先停止");
      if (session.provider === "codex") activeCodexSessionId = session.id;
      const managed = session.provider === "claude" || process.platform !== "win32";
      const run = session.provider === "claude"
        ? await startClaudeRun(session, prompt, settings, (event) => {
          if (event.type === "settings") return;
          void sendBestEffort(config, clientId, { type: "run:event", requestId, sessionKey: key, event, at: Date.now() });
        })
        : managed
        ? sendPrompt(session, prompt, settings, (event) => {
          void send(config, clientId, {
            type: "run:event",
            requestId,
            sessionKey: key,
            event,
            at: Date.now(),
          }).catch(() => undefined);
        })
        : sendToCodexSession(session.id, prompt, desktopOptions(session.id));
      activeRuns.set(key, run);
      void sendRequestResponse(config, clientId, requestId, { type: "run:status", requestId, sessionKey: key, status: "running", mode: managed ? "managed" : "window" });
      try {
        await run.completed;
        invalidateSessions();
        await sendRequestResponse(config, clientId, requestId, { type: "run:status", requestId, sessionKey: key, status: managed ? "completed" : "submitted" });
      } catch (error) {
        await sendRequestResponse(config, clientId, requestId, {
          type: "run:status",
          requestId,
          sessionKey: key,
          status: error?.code === "DELIVERY_UNCERTAIN" ? "uncertain" : "failed",
          error: userFacingError(error),
        });
      } finally {
        activeRuns.delete(key);
        invalidateSessions();
        const updated = await getSession(session.provider, session.id).catch(() => null);
        if (updated) {
          await sendBestEffort(config, clientId, {
            type: "session:snapshot",
            requestId,
            session: stableSessionSnapshot(updated),
          });
        }
        await sendBestEffort(config, clientId, { type: "sessions:snapshot", requestId, sessions: await publicSessions() });
      }
      return;
    }
    throw new Error("手机端请求类型不受支持");
  } catch (error) {
    if (isRelayTimeout(error)) return;
    await sendRequestResponse(config, clientId, requestId, {
      type: "request:error",
      requestId,
      sessionKey: payload?.provider && payload?.sessionId ? `${payload.provider}:${payload.sessionId}` : undefined,
      error: userFacingError(error),
    });
  }
}

async function poll(config) {
  const startingCursor = config.cursor;
  const data = await request(config, `/api/agent/poll?after=${config.cursor}`);
  for (const message of data.messages ?? []) {
    config.cursor = Math.max(config.cursor, Number(message.id) || 0);
    if (message.kind === "pair_request") {
      const pending = JSON.parse(message.envelope);
      config.pendingPairs[pending.requestId] = pending;
      await saveConfig(config);
      openControlPanel();
      console.log(`新的手机绑定请求：${pending.phoneName}`);
      continue;
    }
    if (message.kind === "pairing") {
      const paired = JSON.parse(message.envelope);
      config.clients[paired.clientId] = { publicKey: paired.publicKey, saltHash: paired.codeHash, name: "已绑定手机" };
      await saveConfig(config);
      await send(config, paired.clientId, {
        type: "agent:ready",
        device: { name: config.deviceName, platform: process.platform },
      });
      await send(config, paired.clientId, { type: "sessions:snapshot", sessions: await publicSessions() });
      void getCodexStatus().then((status) => sendBestEffort(config, paired.clientId, { type: "codex:status", status })).catch(() => undefined);
      console.log(`手机已配对：${paired.clientId}`);
      continue;
    }
    if (message.kind !== "encrypted") continue;
    const clientId = message.sender_id;
    try {
      const envelope = JSON.parse(message.envelope);
      const payload = await decryptJson(await clientKey(config, clientId), envelope);
      const claim = await claimMutatingRequest(clientId, payload);
      if (claim !== true && !claim.claimed) {
        if (claim.response) void sendBestEffort(config, clientId, claim.response);
        continue;
      }
      if (claim?.response) void sendBestEffort(config, clientId, claim.response);
      void handleCommand(config, clientId, payload).catch((error) => {
        console.error(`手机请求处理失败：${error instanceof Error ? error.message : error}`);
      });
    } catch (error) {
      console.error(`无法读取手机消息：${error instanceof Error ? error.message : error}`);
    }
  }
  if (config.cursor !== startingCursor) await saveConfig(config);
  return (data.messages ?? []).length;
}

async function controlState(config) {
  const current = Date.now();
  return {
    deviceName: config.deviceName,
    pairKey: config.pairKey,
    providers: await sessionDiagnostics(),
    pending: Object.values(config.pendingPairs).filter((item) => item.expiresAt > current),
    clients: Object.entries(config.clients).map(([clientId, client]) => ({
      clientId,
      name: client.name ?? "已绑定手机",
      createdAt: client.createdAt ?? null,
      activity: clientActivity.get(clientId) ?? null,
    })),
  };
}

async function updateProviderHomes(config, body) {
  const codexHome = normalizeProviderHome("codex", body?.codexHome);
  const claudeHome = normalizeProviderHome("claude", body?.claudeHome ?? config.claudeHome);
  if (codexHome.length > 1_000) throw new Error("目录路径过长");
  config.codexHome = codexHome;
  if (claudeHome.length > 1_000) throw new Error("目录路径过长");
  config.claudeHome = claudeHome;
  configureSessionRoots({ codexHome, claudeHome });
  await saveConfig(config);
  invalidateSessions();
  lastSessionSignature = "";
  const sessions = await publicSessions();
  await Promise.allSettled(
    Object.keys(config.clients).map((clientId) => send(config, clientId, { type: "sessions:snapshot", sessions })),
  );
  return { ok: true, providers: await sessionDiagnostics() };
}

async function approvePair(config, body) {
  const pending = config.pendingPairs[body?.requestId];
  if (!pending || pending.expiresAt < Date.now()) throw new Error("连接请求不存在或已过期");
  const result = await request(config, "/api/agent/pair/approve", {
    method: "POST",
    body: JSON.stringify({ requestId: pending.requestId }),
  });
  config.clients[result.clientId] = {
    publicKey: pending.publicKey,
    saltHash: pending.pairKeyHash,
    name: pending.phoneName,
    createdAt: Date.now(),
  };
  delete config.pendingPairs[pending.requestId];
  keyCache.delete(result.clientId);
  await saveConfig(config);
  await send(config, result.clientId, {
    type: "agent:ready",
    device: { name: config.deviceName, platform: process.platform },
  });
  await send(config, result.clientId, { type: "sessions:snapshot", sessions: await publicSessions() });
  void getCodexStatus().then((status) => sendBestEffort(config, result.clientId, { type: "codex:status", status })).catch(() => undefined);
  return { ok: true };
}

async function rejectPair(config, body) {
  const pending = config.pendingPairs[body?.requestId];
  if (!pending) throw new Error("连接请求不存在");
  await request(config, "/api/agent/pair/reject", {
    method: "POST",
    body: JSON.stringify({ requestId: pending.requestId }),
  });
  delete config.pendingPairs[pending.requestId];
  await saveConfig(config);
  return { ok: true };
}

async function revokeClient(config, body) {
  const clientId = String(body?.clientId ?? "");
  if (!config.clients[clientId]) throw new Error("手机设备不存在");
  await request(config, "/api/agent/client/revoke", {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
  delete config.clients[clientId];
  keyCache.delete(clientId);
  subscriptions.delete(clientId);
  await saveConfig(config);
  return { ok: true };
}

async function syncExternalChanges(config) {
  if (Date.now() - lastExternalSyncAt < 3_000) return;
  lastExternalSyncAt = Date.now();
  invalidateSessions();
  const sessions = await publicSessions();
  const signature = sessions.map((session) => `${session.key}:${Math.trunc(session.updatedAt)}`).join("|");
  if (signature === lastSessionSignature) return;
  lastSessionSignature = signature;
  const current = Date.now();
  const clientIds = Object.keys(config.clients).filter((clientId) => {
    const activity = clientActivity.get(clientId);
    const subscription = subscriptions.get(clientId);
    return Number(activity?.lastRequestAt || 0) >= current - ACTIVE_CLIENT_TTL
      || Number(subscription?.refreshedAt || 0) >= current - SUBSCRIPTION_TTL;
  });
  await Promise.allSettled(
    clientIds.map((clientId) => send(config, clientId, { type: "sessions:snapshot", sessions })),
  );
  await Promise.allSettled(
    clientIds.map(async (clientId) => {
      const subscription = subscriptions.get(clientId);
      if (!subscription) return;
      if (Date.now() - subscription.refreshedAt > SUBSCRIPTION_TTL) {
        subscriptions.delete(clientId);
        return;
      }
      const detail = await sessionDetail(subscription.provider, subscription.sessionId);
      await send(config, clientId, { type: "session:snapshot", session: detail });
    }),
  );
}

async function main() {
  if (command === "start" && !(await acquireAgentLock())) {
    console.log("RelayDesk is already running.");
    return;
  }
  const config = await loadConfig();
  await handledRequests.load();
  configureSessionRoots({ codexHome: config.codexHome, claudeHome: config.claudeHome });
  for (const [clientId, client] of Object.entries(config.clients)) {
    if (client.watch?.key && client.watch?.provider && client.watch?.sessionId) {
      subscriptions.set(clientId, { ...client.watch, refreshedAt: Date.now() });
    }
  }
  const relay = normalizeRelay(argument("relay") ?? process.env.RELAYDESK_URL ?? config.relayUrl ?? DEFAULT_RELAY);
  if (!relay) {
    console.error("请提供中继地址，例如：npm run agent -- --relay https://你的地址");
    process.exitCode = 2;
    return;
  }
  config.relayUrl = relay;
  const siteToken = argument("site-token") ?? process.env.RELAYDESK_SITE_TOKEN ?? config.siteToken;
  if (siteToken) config.siteToken = siteToken;
  await saveConfig(config);

  if (command === "pair" || command === "control") {
    console.log(`\n永久连接密钥：${config.pairKey}\n电脑控制中心：${CONTROL_URL}\n`);
    openControlPanel();
    return;
  }
  if (command !== "start") {
    console.error("可用命令：start、pair、control");
    process.exitCode = 2;
    return;
  }

  console.log(`RelayDesk 已启动：${config.deviceName}`);
  await startControlServer({
    controlToken: config.controlToken,
    getState: async () => controlState(config),
    approve: async (body) => approvePair(config, body),
    reject: async (body) => rejectPair(config, body),
    revoke: async (body) => revokeClient(config, body),
    updateSettings: async (body) => updateProviderHomes(config, body),
  });
  console.log(`电脑控制中心：${CONTROL_URL}`);

  let registered = false;
  let syncing = false;
  setInterval(() => {
    if (!registered || syncing) return;
    syncing = true;
    void syncExternalChanges(config).catch((error) => console.error(`同步暂时中断：${userFacingError(error)}`)).finally(() => { syncing = false; });
  }, 1_500);
  let refreshingStatus = false;
  setInterval(() => {
    if (!registered || refreshingStatus) return;
    const clients = Object.keys(config.clients).filter((id) => Date.now() - (clientActivity.get(id)?.lastRequestAt ?? 0) < ACTIVE_CLIENT_TTL);
    if (!clients.length) return;
    refreshingStatus = true;
    void getClaudeStatus().then((status) => Promise.allSettled(clients.map((id) => sendBestEffort(config, id, { type: "claude:status", status })))).catch(() => undefined);
    void getCodexStatus(true).then((status) => Promise.allSettled(clients.map((id) => sendBestEffort(config, id, { type: "codex:status", status }))))
      .catch(() => undefined).finally(() => { refreshingStatus = false; });
  }, 60_000);

  let heartbeatInFlight = false;
  const heartbeat = async () => {
    if (heartbeatInFlight || !registered) return;
    heartbeatInFlight = true;
    let lastError;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await request(config, "/api/agent/heartbeat", {
            method: "POST",
            signal: AbortSignal.timeout(12_000),
          });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** attempt)));
        }
      }
      console.error(`心跳更新失败：${lastError instanceof Error ? lastError.message : lastError}`);
    } finally {
      heartbeatInFlight = false;
    }
  };
  void heartbeat();
  setInterval(() => void heartbeat(), 60_000);

  let delay = 2_500;
  while (true) {
    try {
      if (!registered) { await register(config); registered = true; console.log("RelayDesk 已连接中继。"); void heartbeat(); }
      const count = await poll(config);
      const active = [...clientActivity.values()].some((item) => Date.now() - (item.lastRequestAt ?? 0) < ACTIVE_CLIENT_TTL);
      delay = count > 0 ? 100 : active ? 1_000 : 2_500;
    } catch (error) {
      if (error?.status === 401) registered = false;
      console.error(`连接暂时中断：${error instanceof Error ? error.message : error}`);
      delay = Math.min(12_000, Math.round(delay * 1.6));
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
