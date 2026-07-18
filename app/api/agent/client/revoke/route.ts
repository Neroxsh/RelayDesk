import { authenticateAgent, jsonError, now, readJson, store, validId } from "../../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ clientId?: string }>(request, 8_000);
    if (!validId(body.clientId)) return jsonError("手机设备无效");
    await store()
      .prepare("UPDATE clients SET revoked_at = ? WHERE id = ? AND device_id = ? AND revoked_at IS NULL")
      .bind(now(), body.clientId, agent.id)
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法解除绑定", 500);
  }
}
