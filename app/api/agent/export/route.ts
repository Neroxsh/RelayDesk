import { authenticateAgent, jsonError, store } from "../../_lib/store";

export async function GET(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return jsonError("设备认证失败", 401);
    const rows = await store()
      .prepare("SELECT id, token_hash, public_key, created_at, last_seen_at, revoked_at FROM clients WHERE device_id = ?")
      .bind(agent.id)
      .all<{
        id: string;
        token_hash: string;
        public_key: string;
        created_at: number;
        last_seen_at: number;
        revoked_at: number | null;
      }>();
    return Response.json({
      clients: (rows.results ?? []).map((client) => ({
        id: client.id,
        tokenHash: client.token_hash,
        publicKey: JSON.parse(client.public_key),
        createdAt: client.created_at,
        lastSeenAt: client.last_seen_at,
        revokedAt: client.revoked_at,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法导出绑定信息", 500);
  }
}
