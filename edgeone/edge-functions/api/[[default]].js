import { getStore } from "@edgeone/pages-blob";

const db = getStore({ name: "relaydesk", consistency: "strong" });
let lastMessageId = 0;
const pairAttempts = new Map();
const DEVICE_ONLINE_WINDOW = 60_000;

const key = {
  device: (id) => `devices/${id}.json`,
  agentToken: (hash) => `agent-tokens/${hash}.json`,
  pairKey: (hash) => `pair-keys/${hash}.json`,
  code: (hash) => `codes/${hash}.json`,
  client: (id) => `clients/${id}.json`,
  clientToken: (hash) => `client-tokens/${hash}.json`,
  pending: (deviceId, id) => `pending/${deviceId}/${id}.json`,
  messages: (target) => `messages/${target.replace(/[^A-Za-z0-9_-]/g, "_")}/`,
};

async function getJson(path) {
  return db.get(path, { type: "json", consistency: "strong" });
}

async function putJson(path, value) {
  await db.setJSON(path, value);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(message, status = 400) {
  return json({ error: message }, status);
}

function now() {
  return Date.now();
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function nextMessageId() {
  const candidate = Date.now() * 1000;
  lastMessageId = Math.max(candidate, lastMessageId + 1);
  return lastMessageId;
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,180}$/.test(value);
}

function createPairRequestId(deviceId) {
  return `pair_${deviceId.length}_${deviceId}_${randomToken(12)}`;
}

function pairRequestDeviceId(requestId) {
  const match = /^pair_(\d{1,3})_/.exec(requestId || "");
  if (!match) return null;
  const length = Number(match[1]);
  const start = match[0].length;
  const deviceId = requestId.slice(start, start + length);
  return validId(deviceId) && requestId[start + length] === "_" ? deviceId : null;
}

function pairedClientIdFromToken(token) {
  const match = /^rdc:([A-Za-z0-9_-]{8,180}):[A-Za-z0-9_-]{16,}$/.exec(token || "");
  return match && pairRequestDeviceId(match[1]) ? match[1] : null;
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validPublicKey(value) {
  return value && typeof value === "object" && value.kty === "EC" && value.crv === "P-256"
    && typeof value.x === "string" && typeof value.y === "string";
}

async function readJson(request, maxBytes = 1_100_000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("请求内容过大");
  return request.json();
}

async function authenticateAgent(request) {
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const claimedDeviceId = request.headers.get("x-relaydesk-device-id") || "";
  if (validId(claimedDeviceId)) {
    const device = await getJson(key.device(claimedDeviceId));
    return device?.agentTokenHash === tokenHash ? device : null;
  }
  const index = await getJson(key.agentToken(tokenHash));
  if (!index?.deviceId) return null;
  const device = await getJson(key.device(index.deviceId));
  return device?.agentTokenHash === tokenHash ? device : null;
}

async function authenticateClient(request) {
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const claimedClientId = request.headers.get("x-relaydesk-client-id") || pairedClientIdFromToken(token) || "";
  if (validId(claimedClientId)) {
    const pendingDeviceId = pairRequestDeviceId(claimedClientId);
    const client = pendingDeviceId
      ? await getJson(key.pending(pendingDeviceId, claimedClientId))
      : await getJson(key.client(claimedClientId));
    return client && !client.revokedAt && client.tokenHash === tokenHash ? client : null;
  }
  const index = await getJson(key.clientToken(tokenHash));
  if (!index?.clientId) return null;
  const client = await getJson(key.client(index.clientId));
  return client && !client.revokedAt && client.tokenHash === tokenHash ? client : null;
}

async function rateLimit(request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || request.headers.get("eo-client-ip") || "local";
  const current = now();
  const bucket = await sha256(`pair:${ip}`);
  const row = pairAttempts.get(bucket);
  if (!row || row.resetAt <= current) {
    pairAttempts.set(bucket, { count: 1, resetAt: current + 15 * 60_000 });
    return true;
  }
  if (row.count >= 8) return false;
  pairAttempts.set(bucket, { ...row, count: row.count + 1 });
  return true;
}

async function addMessage({ deviceId, senderId, targetId, kind = "encrypted", envelope }) {
  const id = nextMessageId();
  const message = { id, device_id: deviceId, sender_id: senderId, kind, envelope, created_at: now() };
  await putJson(`${key.messages(targetId)}${id}.json`, message);
  return id;
}

async function readMessages(targetId, after) {
  const prefix = key.messages(targetId);
  const { blobs = [] } = await db.list({ prefix, consistency: "strong" });
  const selected = blobs
    .map((blob) => ({ path: blob.key, id: Number(blob.key.slice(prefix.length).replace(/\.json$/, "")) }))
    .filter((item) => Number.isFinite(item.id) && item.id > after)
    .sort((a, b) => a.id - b.id)
    .slice(0, 100);
  return (await Promise.all(selected.map((item) => getJson(item.path)))).filter(Boolean);
}

async function readPairRequests(deviceId, after) {
  const prefix = `pending/${deviceId}/`;
  const { blobs = [] } = await db.list({ prefix, consistency: "strong" });
  const rows = await Promise.all(blobs.slice(-20).map((blob) => getJson(blob.key)));
  return rows
    .filter((pending) => pending?.status === "pending" && pending.expiresAt >= now() && pending.messageId > after)
    .map((pending) => ({
      id: pending.messageId,
      device_id: deviceId,
      sender_id: pending.id,
      kind: "pair_request",
      envelope: JSON.stringify({
        requestId: pending.id,
        phoneName: pending.phoneName,
        publicKey: pending.publicKey,
        pairKeyHash: pending.pairKeyHash,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
      }),
      created_at: pending.createdAt,
    }));
}

async function registerDevice(request) {
  const body = await readJson(request, 32_000);
  if (!validId(body.deviceId) || typeof body.agentToken !== "string" || body.agentToken.length < 32) {
    return jsonError("设备凭据无效");
  }
  if (!validPublicKey(body.publicKey)) return jsonError("设备公钥无效");
  if (!validHash(body.pairKeyHash)) return jsonError("永久连接密钥无效");
  const tokenHash = await sha256(body.agentToken);
  const existing = await getJson(key.device(body.deviceId));
  if (existing && existing.agentTokenHash !== tokenHash) return jsonError("设备认证失败", 401);
  if (!existing) {
    try {
      await db.setJSON(key.pairKey(body.pairKeyHash), { deviceId: body.deviceId }, { onlyIfNew: true });
    } catch (error) {
      if (error?.code === "PRECONDITION_FAILED") return jsonError("连接密钥已被使用", 409);
      throw error;
    }
  }
  const timestamp = now();
  const device = {
    ...(existing || {}),
    id: body.deviceId,
    name: String(body.name || "我的电脑").trim().slice(0, 80) || "我的电脑",
    platform: String(body.platform || "unknown").trim().slice(0, 40),
    agentTokenHash: tokenHash,
    publicKey: body.publicKey,
    pairKeyHash: body.pairKeyHash,
    lastSeenAt: timestamp,
    createdAt: existing?.createdAt || timestamp,
  };
  await putJson(key.device(device.id), device);
  return json({ ok: true, deviceId: device.id });
}

async function requestPair(request) {
  if (!(await rateLimit(request))) return jsonError("尝试次数过多，请稍后再试", 429);
  const body = await readJson(request, 32_000);
  if (!validHash(body.pairKeyHash)) return jsonError("连接密钥格式错误");
  if (!validPublicKey(body.publicKey)) return jsonError("手机端密钥无效");
  const owner = await getJson(key.pairKey(body.pairKeyHash));
  const device = owner?.deviceId ? await getJson(key.device(owner.deviceId)) : null;
  if (!device) return jsonError("连接密钥不存在，请检查后重试", 404);
  const requestId = createPairRequestId(device.id);
  const pollToken = randomToken(32);
  const timestamp = now();
  const pending = {
    id: requestId,
    deviceId: device.id,
    phoneName: String(body.phoneName || "手机浏览器").trim().slice(0, 80) || "手机浏览器",
    publicKey: body.publicKey,
    pairKeyHash: body.pairKeyHash,
    pollTokenHash: await sha256(pollToken),
    status: "pending",
    messageId: nextMessageId(),
    createdAt: timestamp,
    expiresAt: timestamp + 10 * 60_000,
  };
  await putJson(key.pending(device.id, requestId), pending);
  return json({ requestId, pollToken, deviceName: device.name, expiresAt: pending.expiresAt });
}

async function pairStatus(request) {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");
  const pollToken = bearer(request);
  if (!validId(requestId) || !pollToken) return jsonError("连接请求无效", 401);
  const deviceId = pairRequestDeviceId(requestId);
  const pending = deviceId ? await getJson(key.pending(deviceId, requestId)) : null;
  if (!pending || pending.pollTokenHash !== await sha256(pollToken)) return jsonError("连接请求无效", 401);
  if (pending.expiresAt < now() && pending.status === "pending") return json({ status: "expired" });
  if (pending.status !== "approved") return json({ status: pending.status });
  const device = await getJson(key.device(pending.deviceId));
  if (!device || !pending.clientId || !pending.clientToken) return jsonError("绑定结果不完整", 500);
  return json({
    status: "approved",
    clientId: pending.clientId,
    clientToken: pending.clientToken,
    device: { id: device.id, name: device.name, platform: device.platform, publicKey: device.publicKey },
  });
}

async function approvePair(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request, 8_000);
  if (!validId(body.requestId)) return jsonError("连接请求无效");
  const pending = await getJson(key.pending(agent.id, body.requestId));
  if (!pending || pending.deviceId !== agent.id) return jsonError("连接请求不存在", 404);
  if (pending.status === "approved" && pending.clientId) return json({ ok: true, clientId: pending.clientId });
  if (pending.status !== "pending" || pending.expiresAt < now()) return jsonError("连接请求已失效", 409);
  const clientId = pending.id;
  const clientToken = `rdc:${pending.id}:${randomToken(24)}`;
  const tokenHash = await sha256(clientToken);
  const timestamp = now();
  await putJson(key.pending(agent.id, body.requestId), {
    ...pending,
    id: clientId,
    tokenHash,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    revokedAt: null,
    status: "approved",
    clientId,
    clientToken,
    resolvedAt: timestamp,
  });
  return json({ ok: true, clientId });
}

async function rejectPair(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request, 8_000);
  if (!validId(body.requestId)) return jsonError("连接请求无效");
  const pending = await getJson(key.pending(agent.id, body.requestId));
  if (pending?.deviceId === agent.id && pending.status === "pending") {
    await putJson(key.pending(agent.id, body.requestId), { ...pending, status: "rejected", resolvedAt: now() });
  }
  return json({ ok: true });
}

async function pollAgent(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const after = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get("after") || "0", 10) || 0);
  const [messages, pairRequests] = await Promise.all([
    readMessages(`agent:${agent.id}`, after),
    readPairRequests(agent.id, after),
  ]);
  messages.push(...pairRequests);
  messages.sort((a, b) => a.id - b.id);
  return json({ messages, cursor: messages.at(-1)?.id || after });
}

async function pollClient(request) {
  const client = await authenticateClient(request);
  if (!client) return jsonError("手机认证失败", 401);
  const after = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get("after") || "0", 10) || 0);
  const timestamp = now();
  const [messages, device] = await Promise.all([
    readMessages(`client:${client.id}`, after),
    getJson(key.device(client.deviceId)),
  ]);
  return json({
    messages,
    cursor: messages.at(-1)?.id || after,
    device: device ? {
      name: device.name,
      platform: device.platform,
      online: timestamp - device.lastSeenAt < DEVICE_ONLINE_WINDOW,
      lastSeenAt: device.lastSeenAt,
    } : null,
  });
}

async function sendFromAgent(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request);
  if (!validId(body.clientId)) return jsonError("手机设备无效");
  const encoded = JSON.stringify(body.envelope);
  if (encoded.length > 1_000_000) return jsonError("消息过大", 413);
  const pendingDeviceId = pairRequestDeviceId(body.clientId);
  const client = pendingDeviceId
    ? await getJson(key.pending(pendingDeviceId, body.clientId))
    : await getJson(key.client(body.clientId));
  if (!client || client.deviceId !== agent.id || client.revokedAt) return jsonError("手机设备不存在", 404);
  const id = await addMessage({ deviceId: agent.id, senderId: `agent:${agent.id}`, targetId: `client:${client.id}`, envelope: encoded });
  return json({ ok: true, id });
}

async function sendFromClient(request) {
  const client = await authenticateClient(request);
  if (!client) return jsonError("手机认证失败", 401);
  const body = await readJson(request);
  const encoded = JSON.stringify(body.envelope);
  if (!body.envelope || encoded.length > 1_000_000) return jsonError("消息无效", 413);
  const id = await addMessage({ deviceId: client.deviceId, senderId: client.id, targetId: `agent:${client.deviceId}`, envelope: encoded });
  return json({ ok: true, id });
}

async function heartbeat(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const timestamp = now();
  await putJson(key.device(agent.id), { ...agent, lastSeenAt: timestamp });
  return json({ ok: true, at: timestamp });
}

async function revokeClient(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request, 8_000);
  if (!validId(body.clientId)) return jsonError("手机设备无效");
  const pendingDeviceId = pairRequestDeviceId(body.clientId);
  const client = pendingDeviceId
    ? await getJson(key.pending(pendingDeviceId, body.clientId))
    : await getJson(key.client(body.clientId));
  if (client?.deviceId === agent.id && !client.revokedAt) {
    const path = pendingDeviceId ? key.pending(pendingDeviceId, body.clientId) : key.client(client.id);
    await putJson(path, { ...client, status: pendingDeviceId ? "revoked" : client.status, revokedAt: now() });
  }
  return json({ ok: true });
}

async function importClients(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request);
  if (!Array.isArray(body.clients) || body.clients.length > 100) return jsonError("迁移数据无效");
  let imported = 0;
  for (const source of body.clients) {
    if (!validId(source.id) || !validHash(source.tokenHash) || !validPublicKey(source.publicKey)) continue;
    const client = {
      id: source.id,
      deviceId: agent.id,
      tokenHash: source.tokenHash,
      publicKey: source.publicKey,
      createdAt: Number(source.createdAt) || now(),
      lastSeenAt: Number(source.lastSeenAt) || now(),
      revokedAt: source.revokedAt ? Number(source.revokedAt) : null,
    };
    await putJson(key.client(client.id), client);
    await putJson(key.clientToken(client.tokenHash), { clientId: client.id });
    imported += 1;
  }
  return json({ ok: true, imported });
}

async function legacyPair(request) {
  if (!(await rateLimit(request))) return jsonError("尝试次数过多，请稍后再试", 429);
  const body = await readJson(request, 32_000);
  if (!validHash(body.codeHash)) return jsonError("配对码格式错误");
  if (!validPublicKey(body.publicKey)) return jsonError("手机端密钥无效");
  const code = await getJson(key.code(body.codeHash));
  const device = code?.deviceId ? await getJson(key.device(code.deviceId)) : null;
  if (!device || code.expiresAt < now()) return jsonError("配对码不存在或已过期", 404);
  const clientId = `client_${randomToken(12)}`;
  const clientToken = randomToken(32);
  const tokenHash = await sha256(clientToken);
  const timestamp = now();
  const client = { id: clientId, deviceId: device.id, tokenHash, publicKey: body.publicKey, createdAt: timestamp, lastSeenAt: timestamp, revokedAt: null };
  await putJson(key.client(clientId), client);
  await putJson(key.clientToken(tokenHash), { clientId });
  await db.delete(key.code(body.codeHash));
  await addMessage({ deviceId: device.id, senderId: clientId, targetId: `agent:${device.id}`, kind: "pairing", envelope: JSON.stringify({ clientId, publicKey: body.publicKey, codeHash: body.codeHash }) });
  return json({ clientId, clientToken, device: { id: device.id, name: device.name, platform: device.platform, publicKey: device.publicKey } });
}

async function setPairCode(request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const body = await readJson(request, 8_000);
  if (!validHash(body.codeHash)) return jsonError("配对码无效");
  const expiresAt = now() + 10 * 60_000;
  await putJson(key.code(body.codeHash), { deviceId: agent.id, expiresAt });
  await putJson(key.device(agent.id), { ...agent, lastSeenAt: now() });
  return json({ ok: true, expiresAt });
}

export default async function onRequest(context) {
  const { request } = context;
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && path === "/api/status") return json({ ok: true, service: "RelayDesk", region: "edgeone", time: now() });
    if (request.method === "POST" && path === "/api/device/register") return registerDevice(request);
    if (request.method === "POST" && path === "/api/pair/request") return requestPair(request);
    if (request.method === "GET" && path === "/api/pair/status") return pairStatus(request);
    if (request.method === "POST" && path === "/api/agent/pair/approve") return approvePair(request);
    if (request.method === "POST" && path === "/api/agent/pair/reject") return rejectPair(request);
    if (request.method === "GET" && path === "/api/agent/poll") return pollAgent(request);
    if (request.method === "GET" && path === "/api/client/poll") return pollClient(request);
    if (request.method === "POST" && path === "/api/agent/send") return sendFromAgent(request);
    if (request.method === "POST" && path === "/api/client/send") return sendFromClient(request);
    if (request.method === "POST" && path === "/api/agent/heartbeat") return heartbeat(request);
    if (request.method === "POST" && path === "/api/agent/client/revoke") return revokeClient(request);
    if (request.method === "POST" && path === "/api/agent/import") return importClients(request);
    if (request.method === "POST" && path === "/api/device/pair-code") return setPairCode(request);
    if (request.method === "POST" && path === "/api/pair") return legacyPair(request);
    return jsonError("接口不存在", 404);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "服务暂时不可用", 500);
  }
}
