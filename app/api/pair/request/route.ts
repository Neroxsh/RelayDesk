import { ensureSchema, first, jsonError, now, randomToken, rateLimitPair, readJson, sha256, store, validHash, validPublicKey } from "../../_lib/store";

type PairRequestBody = {
  pairKeyHash?: string;
  publicKey?: JsonWebKey;
  phoneName?: string;
};

export async function POST(request: Request) {
  try {
    await ensureSchema();
    if (!(await rateLimitPair(request))) return jsonError("尝试次数过多，请稍后再试", 429);
    const body = await readJson<PairRequestBody>(request, 32_000);
    if (!validHash(body.pairKeyHash)) return jsonError("连接密钥格式错误");
    if (!validPublicKey(body.publicKey)) return jsonError("手机端密钥无效");
    const db = store();
    const device = await first<{ id: string; name: string }>(
      db.prepare("SELECT id, name FROM devices WHERE pair_key_hash = ?").bind(body.pairKeyHash),
    );
    if (!device) return jsonError("连接密钥不存在，请检查后重试", 404);

    const requestId = `pair_${randomToken(12)}`;
    const pollToken = randomToken(32);
    const timestamp = now();
    const expiresAt = timestamp + 10 * 60_000;
    const phoneName = (body.phoneName ?? "手机浏览器").trim().slice(0, 80) || "手机浏览器";
    await db.batch([
      db
        .prepare(`INSERT INTO pending_pairs(
          id, device_id, phone_name, public_key, pair_key_hash, poll_token_hash, status, created_at, expires_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .bind(
          requestId,
          device.id,
          phoneName,
          JSON.stringify(body.publicKey),
          body.pairKeyHash,
          await sha256(pollToken),
          timestamp,
          expiresAt,
        ),
      db
        .prepare("INSERT INTO messages(device_id, sender_id, target_id, kind, envelope, created_at) VALUES(?, ?, ?, 'pair_request', ?, ?)")
        .bind(
          device.id,
          requestId,
          `agent:${device.id}`,
          JSON.stringify({
            requestId,
            phoneName,
            publicKey: body.publicKey,
            pairKeyHash: body.pairKeyHash,
            createdAt: timestamp,
            expiresAt,
          }),
          timestamp,
        ),
    ]);
    return Response.json({ requestId, pollToken, deviceName: device.name, expiresAt });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法提交连接请求", 500);
  }
}
