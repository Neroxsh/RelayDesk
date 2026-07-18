import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, randomToken, sha256 } from "./crypto.mjs";
import { getSession, invalidateSessions, listSessions } from "./sessions.mjs";
import { sendPrompt, sendToCurrentCodex } from "./providers.mjs";
import { CONTROL_URL, openControlPanel, startControlServer } from "./control-server.mjs";

const CONFIG_DIR = path.join(os.homedir(), ".relaydesk");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const HTTP_BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "http-bridge.ps1");
const command = process.argv[2] ?? "start";
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let bridgeProcess;
let bridgeSequence = 0;
const bridgePending = new Map();

function powershellRequest(url, options) {
  if (!bridgeProcess || bridgeProcess.exitCode !== null) {
    bridgeProcess = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HTTP_BRIDGE],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: bridgeProcess.stdout });
    lines.on("line", (line) => {
      try {
        const result = JSON.parse(line);
        const pending = bridgePending.get(result.id);
        if (!pending) return;
        bridgePending.delete(result.id);
        pending.resolve(result);
      } catch {
        // Ignore non-protocol output from Windows PowerShell.
      }
    });
    bridgeProcess.once("exit", () => {
      for (const pending of bridgePending.values()) pending.reject(new Error("Windows network bridge stopped"));
      bridgePending.clear();
      bridgeProcess = null;
    });
  }
  const id = ++bridgeSequence;
  return new Promise((resolve, reject) => {
    bridgePending.set(id, { resolve, reject });
    bridgeProcess.stdin.write(`${JSON.stringify({
      id,
      url,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ?? null,
    })}\n`);
  });
}

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
    ...(options.headers ?? {}),
  };
  let status;
  let responseBody;
  if (process.platform === "win32") {
    const result = await powershellRequest(`${config.relayUrl}${pathname}`, { ...options, headers });
    status = result.status;
    responseBody = result.body;
  } else {
    const response = await fetch(`${config.relayUrl}${pathname}`, { ...options, headers });
    status = response.status;
    responseBody = await response.text();
  }
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
let lastSessionSignature = "";
let lastExternalSyncAt = 0;

async function publicSessions() {
  const source = await listSessions();
  const latestCodex = source.find((session) => session.provider === "codex");
  const sessions = source.map((session) => {
    const result = { ...session, active: activeRuns.has(session.key) };
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
    if (payload?.type === "session:get") {
      const session = payload.provider === "codex" && payload.sessionId === "__current__"
        ? await currentCodexDetail()
        : await getSession(payload.provider, payload.sessionId);
      subscriptions.set(clientId, session.key);
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
        if (activeRuns.has(key)) throw new Error("正在把上一条指令发送到 Codex");
        const run = sendToCurrentCodex(prompt);
        activeRuns.set(key, run);
        await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "running", mode: "window" });
        try {
          await run.completed;
          await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "submitted" });
        } finally {
          activeRuns.delete(key);
          invalidateSessions();
        }
        return;
      }
      const session = await getSession(payload.provider, payload.sessionId);
      const key = `${session.provider}:${session.id}`;
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
      await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "running", mode });
      try {
        await run.completed;
        invalidateSessions();
        await send(config, clientId, { type: "run:status", requestId, sessionKey: key, status: "completed" });
      } catch (error) {
        await send(config, clientId, {
          type: "run:status",
          requestId,
          sessionKey: key,
          status: "failed",
          error: error instanceof Error ? error.message : "执行失败",
        });
      } finally {
        activeRuns.delete(key);
        invalidateSessions();
        const updated = await getSession(session.provider, session.id).catch(() => null);
        if (updated) await send(config, clientId, { type: "session:snapshot", requestId, session: updated });
        await send(config, clientId, { type: "sessions:snapshot", requestId, sessions: await publicSessions() });
      }
      return;
    }
    throw new Error("手机端请求类型不受支持");
  } catch (error) {
    await send(config, clientId, {
      type: "request:error",
      requestId,
      error: error instanceof Error ? error.message : "请求失败",
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
      void handleCommand(config, clientId, payload);
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
  if (Date.now() - lastExternalSyncAt < 2_500) return;
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
      const selectedKey = subscriptions.get(clientId);
      if (!selectedKey) return;
      const selected = sessions.find((session) => session.key === selectedKey);
      if (!selected) return;
      const detail = await getSession(selected.provider, selected.id);
      await send(config, clientId, { type: "session:snapshot", session: detail });
    }),
  );
}

async function main() {
  const config = await loadConfig();
  const relay = normalizeRelay(argument("relay") ?? process.env.RELAYDESK_URL ?? config.relayUrl);
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
    bridgeProcess?.stdin.end();
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

  let delay = 1_200;
  while (true) {
    try {
      await poll(config);
      await syncExternalChanges(config);
      delay = 1_200;
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
