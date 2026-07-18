import { bearer, ensureSchema, first, jsonError, now, sha256, store, validId } from "../../_lib/store";

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");
    const pollToken = bearer(request);
    if (!validId(requestId) || !pollToken) return jsonError("连接请求无效", 401);
    const row = await first<{
      status: string;
      client_id: string | null;
      client_token: string | null;
      expires_at: number;
      device_id: string;
      poll_token_hash: string;
    }>(store().prepare("SELECT status, client_id, client_token, expires_at, device_id, poll_token_hash FROM pending_pairs WHERE id = ?").bind(requestId));
    if (!row || row.poll_token_hash !== (await sha256(pollToken))) return jsonError("连接请求无效", 401);
    if (row.expires_at < now() && row.status === "pending") return Response.json({ status: "expired" });
    if (row.status !== "approved") return Response.json({ status: row.status });
    const device = await first<{ id: string; name: string; platform: string; public_key: string }>(
      store().prepare("SELECT id, name, platform, public_key FROM devices WHERE id = ?").bind(row.device_id),
    );
    if (!device || !row.client_id || !row.client_token) return jsonError("绑定结果不完整", 500);
    return Response.json({
      status: "approved",
      clientId: row.client_id,
      clientToken: row.client_token,
      device: { id: device.id, name: device.name, platform: device.platform, publicKey: JSON.parse(device.public_key) },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法查询连接状态", 500);
  }
}
