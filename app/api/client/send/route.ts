import { authenticateClient, jsonError, now, readJson, store } from "../../_lib/store";

export async function POST(request: Request) {
  try {
    const client = await authenticateClient(request);
    if (!client) return jsonError("手机认证失败", 401);
    const body = await readJson<{ envelope?: unknown }>(request);
    const encoded = JSON.stringify(body.envelope);
    if (!body.envelope || encoded.length > 1_000_000) return jsonError("消息无效", 413);
    const result = await store()
      .prepare("INSERT INTO messages(device_id, sender_id, target_id, kind, envelope, created_at) VALUES(?, ?, ?, 'encrypted', ?, ?)")
      .bind(client.device_id, client.id, `agent:${client.device_id}`, encoded, now())
      .run();
    return Response.json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "发送失败", 500);
  }
}
