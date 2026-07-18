import { authenticateAgent, jsonError, now, readJson, store, validId } from "../../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ requestId?: string }>(request, 8_000);
    if (!validId(body.requestId)) return jsonError("连接请求无效");
    await store()
      .prepare("UPDATE pending_pairs SET status = 'rejected', resolved_at = ? WHERE id = ? AND device_id = ? AND status = 'pending'")
      .bind(now(), body.requestId, agent.id)
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法拒绝绑定", 500);
  }
}
