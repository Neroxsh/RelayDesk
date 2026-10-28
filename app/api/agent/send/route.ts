import { authenticateAgent, first, jsonError, now, pruneMessageQueue, readJson, store, validId } from "../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ clientId?: string; envelope?: unknown; deliveryId?: unknown }>(request);
    if (body.deliveryId !== undefined && !validId(body.deliveryId)) return jsonError("消息标识无效");
    if (!validId(body.clientId)) return jsonError("手机设备无效");
    const encoded = JSON.stringify(body.envelope);
    if (!body.envelope || !encoded || encoded.length > 1_000_000) return jsonError("消息无效或过大", 413);
    const db = store();
    const client = await first<{ id: string }>(
      db.prepare("SELECT id FROM clients WHERE id = ? AND device_id = ? AND revoked_at IS NULL").bind(body.clientId, agent.id),
    );
    if (!client) return jsonError("手机设备不存在", 404);
    const targetId = `client:${client.id}`;
    const timestamp = now();
    const result = await db
      .prepare("INSERT OR IGNORE INTO messages(device_id, sender_id, target_id, kind, envelope, created_at, delivery_id) VALUES(?, ?, ?, 'encrypted', ?, ?, ?)")
      .bind(agent.id, `agent:${agent.id}`, targetId, encoded, timestamp, body.deliveryId ?? null)
      .run();
    const existing = body.deliveryId ? await first<{ id: number }>(db.prepare("SELECT id FROM messages WHERE sender_id = ? AND delivery_id = ?").bind(`agent:${agent.id}`, body.deliveryId)) : null;
    await pruneMessageQueue(targetId, timestamp);
    return Response.json({ ok: true, id: existing?.id ?? result.meta.last_row_id });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "发送失败", 500);
  }
}
