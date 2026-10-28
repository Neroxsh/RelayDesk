import { authenticateClient, first, jsonError, now, pruneMessageQueue, readJson, store, validId } from "../../_lib/store";

export async function POST(request: Request) {
  try {
    const client = await authenticateClient(request);
    if (!client) return jsonError("手机认证失败", 401);
    const body = await readJson<{ envelope?: unknown; deliveryId?: unknown }>(request);
    if (body.deliveryId !== undefined && !validId(body.deliveryId)) return jsonError("消息标识无效");
    const encoded = JSON.stringify(body.envelope);
    if (!body.envelope || encoded.length > 1_000_000) return jsonError("消息无效", 413);
    const targetId = `agent:${client.device_id}`;
    const timestamp = now();
    const result = await store()
      .prepare("INSERT OR IGNORE INTO messages(device_id, sender_id, target_id, kind, envelope, created_at, delivery_id) VALUES(?, ?, ?, 'encrypted', ?, ?, ?)")
      .bind(client.device_id, client.id, targetId, encoded, timestamp, body.deliveryId ?? null)
      .run();
    const existing = body.deliveryId ? await first<{ id: number }>(store().prepare("SELECT id FROM messages WHERE sender_id = ? AND delivery_id = ?").bind(client.id, body.deliveryId)) : null;
    await pruneMessageQueue(targetId, timestamp);
    return Response.json({ ok: true, id: existing?.id ?? result.meta.last_row_id });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "发送失败", 500);
  }
}
