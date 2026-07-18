import { authenticateAgent, jsonError, now, readJson, store } from "../../_lib/store";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const body = await readJson<{ codeHash?: string }>(request, 8_000);
    if (typeof body.codeHash !== "string" || !/^[a-f0-9]{64}$/.test(body.codeHash)) {
      return jsonError("配对码无效");
    }
    const expiresAt = now() + 10 * 60_000;
    await store()
      .prepare("UPDATE devices SET code_hash = ?, code_expires_at = ?, last_seen_at = ? WHERE id = ?")
      .bind(body.codeHash, expiresAt, now(), agent.id)
      .run();
    return Response.json({ ok: true, expiresAt });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法创建配对码", 500);
  }
}
