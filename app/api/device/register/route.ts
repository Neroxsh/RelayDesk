import { ensureSchema, first, jsonError, now, readJson, sha256, store, validId, validPublicKey } from "../../_lib/store";

type RegisterBody = {
  deviceId?: string;
  agentToken?: string;
  name?: string;
  platform?: string;
  publicKey?: JsonWebKey;
};

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = await readJson<RegisterBody>(request, 32_000);
    if (!validId(body.deviceId) || typeof body.agentToken !== "string" || body.agentToken.length < 32) {
      return jsonError("设备凭据无效");
    }
    if (!validPublicKey(body.publicKey)) return jsonError("设备公钥无效");
    const db = store();
    const tokenHash = await sha256(body.agentToken);
    const existing = await first<{ agent_token_hash: string }>(
      db.prepare("SELECT agent_token_hash FROM devices WHERE id = ?").bind(body.deviceId),
    );
    if (existing && existing.agent_token_hash !== tokenHash) return jsonError("设备认证失败", 401);
    const timestamp = now();
    const name = (body.name ?? "我的电脑").trim().slice(0, 80) || "我的电脑";
    const platform = (body.platform ?? "unknown").trim().slice(0, 40);
    const publicKey = JSON.stringify(body.publicKey);
    await db
      .prepare(`INSERT INTO devices(id, name, platform, agent_token_hash, public_key, last_seen_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
          public_key = excluded.public_key, last_seen_at = excluded.last_seen_at`)
      .bind(body.deviceId, name, platform, tokenHash, publicKey, timestamp, timestamp)
      .run();
    return Response.json({ ok: true, deviceId: body.deviceId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "注册失败", 500);
  }
}
