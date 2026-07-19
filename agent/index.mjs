import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, randomToken, sha256 } from "./crypto.mjs";
import { getSession, invalidateSessions, listSessions } from "./sessions.mjs";
import { sendPrompt, sendToCurrentCodex } from "./providers.mjs";
import { CONTROL_URL, openControlPanel, startControlServer } from "./control-server.mjs";

const CONFIG_DIR = path.join(os.homedir(), ".relaydesk");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const command = process.argv[2] ?? "start";
const DEFAULT_RELAY = "https://relay.xingshihao.site";
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const temporary = `${CONFIG_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
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
    if (error?.code !== "ENOENT") throw error;
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
  if (changed || !config.createdAt) await saveConfig(config);
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
  const { auth: _auth, ...fetchOptions } = options;
  const response = await fetch(`${config.relayUrl}${pathname}`, {
    ...fetchOptions,
    headers,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  const status = response.status;
  const responseBody = await response.text();
  let data = {};
  try {
    data = responseBody ? JSON.parse(responseBody) : {};
  } catch {
    // Preserve a useful status error when a gateway returns HTML.
  }
  if (status < 200 || status >= 300) throw new Error(data.error ?? `中继服务返回 ${status}`);
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
  const envelope = await encryptJson(key, payload);
  await request(config, "/api/agent/send", {
    method: "POST",
    body: JSON.stringify({ clientId, envelope }),
  });
}

const activeRuns = new Map();
const subscriptions = new Map();
const stableSnapshots = new Map();
let lastSessionSignature = "";
let lastExternalSyncAt = 0;
const SUBSCRIPTION_TTL = 45_000;

function messageSignature(message) {
  return `${message.role}\u0000${message.timestamp ?? ""}\u0000${message.content}`;
}

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
  const messages = [...(previous.messages ?? [])];
  const seen = new Set(messages.map(messageSignature));
  for (const message of session.messages ?? []) {
    const signature = messageSignature(message);
    if (seen.has(signature)) continue;
    seen.add(signature);
    messages.push(message);
  }
  const merged = { ...previous, ...session, messages: messages.slice(-240) };
  stableSnapshots.set(session.key, merged);
  return merged;
}

function isRelayTimeout(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /aborted|aborterror|timeout|timed out/i.test(message);
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
  try {
    await send(config, clientId, payload);
    return true;
  } catch (error) {
    console.error(`状态回传失败：${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function publicSessions() {
  const source = await listSessions();
  const latestCodex = source.find((session) => session.provider === "codex");
  const sessions = source.map((session) => {
    const result = {
      ...session,
      active: activeRuns.has(session.key),
      openInCodex: session.provider === "codex" && session.id === latestCodex?.id,
    };
    delete result.filePath;
    return result;
  });
  sessions.unshift({
    id: "__current__",
    key: "codex:__current__",
    provider: "codex",
    title: "当前 Codex 窗口",
    cwd: latestCodex?.cwd ?? "",
    projectName: "当前窗口",
    updatedAt: latestCodex?.updatedAt ?? Date.now(),
    recent: true,
    active: activeRuns.has("codex:__current__"),
    currentWindow: true,
  });
  return sessions;
}

async function currentCodexDetail() {
  const source = await listSessions(true);
  const latest = source.find((session) => session.provider === "codex");
  const detail = latest ? await getSession("codex", latest.id) : { messages: [] };
  return {
    ...detail,
    id: "__current__",
    key: "codex:__current__",
    provider: "codex",
    title: "当前 Codex 窗口",
    currentWindow: true,
    sourceSessionId: latest?.id ?? null,
  };
}

async function sessionDetail(provider, sessionId) {
  const session = await (provider === "codex" && sessionId === "__current__"
    ? currentCodexDetail()
    : getSession(provider, sessionId));
  return stableSessionSnapshot(session);
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
  try {
    if (payload?.type === "ping") {
      await send(config, clientId, { type: "pong", requestId, at: Date.now() });
      return;
    }
    if (payload?.type === "sessions:list") {
      await send(config, clientId, { type: "sessions:snapshot", requestId, sessions: await publicSessions() });
      return;
    }
    if (["session:get", "session:watch"].includes(payload?.type)) {
      const session = await sessionDetail(payload.provider, payload.sessionId);
      await watchSession(config, clientId, session);
      await send(config, clientId, { type: "session:snapshot", requestId, session });
      return;
    }
    if (payload?.type === "session:stop") {
      const key = `${payload.provider}:${payload.sessionId}`;
      const run = activeRuns.get(key);
      if (!run) throw new Error("这个会话当前没有正在执行的任务");
      run.stop();
      await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "stopping" });
      return;
    }
    if (payload?.type === "session:send") {
      const prompt = String(payload.prompt ?? "").trim();
      if (!prompt || prompt.length > 12_000) throw new Error("指令需为 1–12000 个字符");
      const mode = payload.mode === "full" ? "full" : "safe";
      if (payload.provider === "codex" && payload.sessionId === "__current__") {
        const key = "codex:__current__";
        await watchSession(config, clientId, { key, provider: "codex", id: "__current__" });
        if (activeRuns.has(key)) throw new Error("正在把上一条指令发送到 Codex");
        const run = sendToCurrentCodex(prompt);
        activeRuns.set(key, run);
        void sendBestEffort(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "running", mode: "window" });
        try {
          await run.completed;
        } catch (error) {
          await sendBestEffort(config, clientId, {
            type: "run:status",
            requestId,
            sessionKey: key,
            status: "failed",
            error: userFacingError(error),
          });
          return;
        } finally {
          activeRuns.delete(key);
          invalidateSessions();
        }
        await sendBestEffort(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "submitted" });
        return;
      }
      const session = await getSession(payload.provider, payload.sessionId);
      const key = `${session.provider}:${session.id}`;
      await watchSession(config, clientId, session);
      if (activeRuns.has(key)) throw new Error("这个会话仍在执行，请等待或先停止");
      const run = sendPrompt(session, prompt, mode, (event) => {
        void send(config, clientId, {
          type: "run:event",
          requestId,
          sessionKey: key,
          event,
          at: Date.now(),
        }).catch(() => undefined);
      });
      activeRuns.set(key, run);
      void sendBestEffort(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "running", mode });
      try {
        await run.completed;
        invalidateSessions();
        await sendBestEffort(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "completed" });
      } catch (error) {
        await sendBestEffort(config, clientId, {
          type: "run:status",
          requestId,
          sessionKey: key,
          status: "failed",
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
    await sendBestEffort(config, clientId, {
      type: "request:error",
      requestId,
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
      console.log(`手机已配对：${paired.clientId}`);
      continue;
    }
    if (message.kind !== "encrypted") continue;
    const clientId = message.sender_id;
    try {
      const envelope = JSON.parse(message.envelope);
      const payload = await decryptJson(await clientKey(config, clientId), envelope);
      void handleCommand(config, clientId, payload).catch((error) => {
        console.error(`手机请求处理失败：${error instanceof Error ? error.message : error}`);
      });
    } catch (error) {
      console.error(`无法读取手机消息：${error instanceof Error ? error.message : error}`);
    }
  }
  if (config.cursor !== startingCursor) await saveConfig(config);
}

function controlState(config) {
  const current = Date.now();
  return {
    deviceName: config.deviceName,
    pairKey: config.pairKey,
    pending: Object.values(config.pendingPairs).filter((item) => item.expiresAt > current),
    clients: Object.entries(config.clients).map(([clientId, client]) => ({
      clientId,
      name: client.name ?? "已绑定手机",
      createdAt: client.createdAt ?? null,
    })),
  };
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
  const clientIds = Object.keys(config.clients);
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
  const config = await loadConfig();
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
  await register(config);

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

  console.log(`RelayDesk 已连接：${config.deviceName}`);
  await startControlServer({
    controlToken: config.controlToken,
    getState: async () => controlState(config),
    approve: async (body) => approvePair(config, body),
    reject: async (body) => rejectPair(config, body),
    revoke: async (body) => revokeClient(config, body),
  });
  console.log(`电脑控制中心：${CONTROL_URL}`);

  let heartbeatInFlight = false;
  const heartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await request(config, "/api/agent/heartbeat", { method: "POST" });
    } catch (error) {
      console.error(`心跳更新失败：${error instanceof Error ? error.message : error}`);
    } finally {
      heartbeatInFlight = false;
    }
  };
  void heartbeat();
  setInterval(() => void heartbeat(), 5_000);

  let delay = 700;
  while (true) {
    try {
      await poll(config);
      await syncExternalChanges(config);
      delay = 700;
    } catch (error) {
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
