import { authenticateAgent, first, jsonError, now, readJson, store, validId } from "../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ clientId?: string; envelope?: unknown }>(request);
    if (!validId(body.clientId)) return jsonError("手机设备无效");
    const encoded = JSON.stringify(body.envelope);
    if (encoded.length > 1_000_000) return jsonError("消息过大", 413);
    const db = store();
    const client = await first<{ id: string }>(
      db.prepare("SELECT id FROM clients WHERE id = ? AND device_id = ? AND revoked_at IS NULL").bind(body.clientId, agent.id),
    );
    if (!client) return jsonError("手机设备不存在", 404);
    const result = await db
      .prepare("INSERT INTO messages(device_id, sender_id, target_id, kind, envelope, created_at) VALUES(?, ?, ?, 'encrypted', ?, ?)")
      .bind(agent.id, `agent:${agent.id}`, `client:${client.id}`, encoded, now())
      .run();
    return Response.json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "发送失败", 500);
  }
}
