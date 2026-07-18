import { authenticateAgent, first, jsonError, now, randomToken, readJson, sha256, store, validId } from "../../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ requestId?: string }>(request, 8_000);
    if (!validId(body.requestId)) return jsonError("连接请求无效");
    const db = store();
    const pending = await first<{ status: string; expires_at: number; client_id: string | null }>(
      db.prepare("SELECT status, expires_at, client_id FROM pending_pairs WHERE id = ? AND device_id = ?").bind(body.requestId, agent.id),
    );
    if (!pending) return jsonError("连接请求不存在", 404);
    if (pending.status === "approved" && pending.client_id) return Response.json({ ok: true, clientId: pending.client_id });
    if (pending.status !== "pending" || pending.expires_at < now()) return jsonError("连接请求已失效", 409);
    const clientId = `client_${randomToken(12)}`;
    const clientToken = randomToken(32);
    const timestamp = now();
    const phone = await first<{ public_key: string }>(
      db.prepare("SELECT public_key FROM pending_pairs WHERE id = ?").bind(body.requestId),
    );
    if (!phone) return jsonError("手机公钥不存在", 404);
    await db.batch([
      db
        .prepare("INSERT INTO clients(id, device_id, token_hash, public_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)")
        .bind(clientId, agent.id, await sha256(clientToken), phone.public_key, timestamp, timestamp),
      db
        .prepare("UPDATE pending_pairs SET status = 'approved', client_id = ?, client_token = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .bind(clientId, clientToken, timestamp, body.requestId),
      db.prepare("UPDATE devices SET paired_at = COALESCE(paired_at, ?) WHERE id = ?").bind(timestamp, agent.id),
    ]);
    return Response.json({ ok: true, clientId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法确认绑定", 500);
  }
}
