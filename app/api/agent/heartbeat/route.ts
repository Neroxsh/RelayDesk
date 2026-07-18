import { authenticateAgent, jsonError, now, store } from "../../_lib/store";

export async function POST(request: Request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  await store().prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now(), agent.id).run();
  return Response.json({ ok: true, at: now() });
}
