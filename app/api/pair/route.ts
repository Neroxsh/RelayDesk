import { ensureSchema, first, jsonError, now, randomToken, rateLimitPair, readJson, sha256, store, validPublicKey } from "../_lib/store";

export async function POST(request: Request) {
  try {
    await ensureSchema();
    if (!(await rateLimitPair(request))) return jsonError("尝试次数过多，请稍后再试", 429);
    const body = await readJson<{ codeHash?: string; publicKey?: JsonWebKey }>(request, 32_000);
    if (typeof body.codeHash !== "string" || !/^[a-f0-9]{64}$/.test(body.codeHash)) {
      return jsonError("配对码格式错误");
    }
    if (!validPublicKey(body.publicKey)) return jsonError("手机端密钥无效");
    const db = store();
    const device = await first<{
      id: string;
      name: string;
      platform: string;
      public_key: string;
      code_expires_at: number;
    }>(db.prepare("SELECT id, name, platform, public_key, code_expires_at FROM devices WHERE code_hash = ?").bind(body.codeHash));
    if (!device || device.code_expires_at < now()) return jsonError("配对码不存在或已过期", 404);

    const clientId = `client_${randomToken(12)}`;
    const clientToken = randomToken(32);
    const timestamp = now();
    const tokenHash = await sha256(clientToken);
    await db.batch([
      db
        .prepare("INSERT INTO clients(id, device_id, token_hash, public_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)")
        .bind(clientId, device.id, tokenHash, JSON.stringify(body.publicKey), timestamp, timestamp),
      db
        .prepare("UPDATE devices SET code_hash = NULL, code_expires_at = NULL, paired_at = COALESCE(paired_at, ?) WHERE id = ?")
        .bind(timestamp, device.id),
      db
        .prepare("INSERT INTO messages(device_id, sender_id, target_id, kind, envelope, created_at) VALUES(?, ?, ?, 'pairing', ?, ?)")
        .bind(
          device.id,
          clientId,
          `agent:${device.id}`,
          JSON.stringify({ clientId, publicKey: body.publicKey, codeHash: body.codeHash }),
          timestamp,
        ),
    ]);
    return Response.json({
      clientId,
      clientToken,
      device: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        publicKey: JSON.parse(device.public_key),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "配对失败", 500);
  }
}
