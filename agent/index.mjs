import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, randomToken, sha256 } from "./crypto.mjs";
import { getSession, invalidateSessions, listSessions } from "./sessions.mjs";
import { sendPrompt } from "./providers.mjs";

const CONFIG_DIR = path.join(os.homedir(), ".relaydesk");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const HTTP_BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "http-bridge.ps1");
const command = process.argv[2] ?? "start";

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

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const keys = await generateDeviceKeys();
    const config = {
      version: 1,
      relayUrl: "",
      siteToken: "",
      deviceId: `device_${randomToken(12)}`,
      agentToken: randomToken(32),
      deviceName: os.hostname(),
      keys,
      clients: {},
      cursor: 0,
    };
    await saveConfig(config);
    return config;
  }
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
    }),
  });
}

async function createPairCode(config) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await request(config, "/api/device/pair-code", {
    method: "POST",
    body: JSON.stringify({ codeHash: sha256(code) }),
  });
  return code;
}

const keyCache = new Map();

async function clientKey(config, clientId) {
  if (keyCache.has(clientId)) return keyCache.get(clientId);
  const client = config.clients[clientId];
  if (!client) throw new Error("未知手机设备");
  const key = await deriveSessionKey(config.keys.privateKey, client.publicKey, client.codeHash);
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
  return (await listSessions()).map((session) => {
    const result = { ...session, active: activeRuns.has(session.key) };
    delete result.filePath;
    return result;
  });
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
      const session = await getSession(payload.provider, payload.sessionId);
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
    if (message.kind === "pairing") {
      const paired = JSON.parse(message.envelope);
      config.clients[paired.clientId] = { publicKey: paired.publicKey, codeHash: paired.codeHash };
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

  if (command === "pair") {
    const code = await createPairCode(config);
    console.log(`\n配对码：${code}\n10 分钟内在手机网页输入此号码。\n`);
    bridgeProcess?.stdin.end();
    return;
  }
  if (command !== "start") {
    console.error("可用命令：start、pair");
    process.exitCode = 2;
    return;
  }

  console.log(`RelayDesk 已连接：${config.deviceName}`);
  if (Object.keys(config.clients).length === 0) {
    const code = await createPairCode(config);
    console.log(`首次配对码：${code}（10 分钟有效）`);
  }

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
