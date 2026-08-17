import { authenticateAgent, deleteDeliveredMessages, jsonError, store, touchDevicePresence } from "../../_lib/store";

export async function GET(request: Request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const url = new URL(request.url);
  const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
  const db = store();
  await touchDevicePresence(agent.id);
  await deleteDeliveredMessages(`agent:${agent.id}`, after);
  const rows = await db
    .prepare("SELECT id, sender_id, kind, envelope, created_at FROM messages WHERE target_id = ? AND id > ? ORDER BY id ASC LIMIT 100")
    .bind(`agent:${agent.id}`, after)
    .all();
  return Response.json({ messages: rows.results ?? [], cursor: rows.results?.at(-1)?.id ?? after });
}
