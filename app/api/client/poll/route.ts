import { authenticateClient, first, jsonError, now, store } from "../../_lib/store";

export async function GET(request: Request) {
  const client = await authenticateClient(request);
  if (!client) return jsonError("手机认证失败", 401);
  const url = new URL(request.url);
  const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
  const db = store();
  await db.prepare("UPDATE clients SET last_seen_at = ? WHERE id = ?").bind(now(), client.id).run();
  const [rows, device] = await Promise.all([
    db
      .prepare("SELECT id, kind, envelope, created_at FROM messages WHERE target_id = ? AND id > ? ORDER BY id ASC LIMIT 100")
      .bind(`client:${client.id}`, after)
      .all(),
    first<{ name: string; platform: string; last_seen_at: number }>(
      db.prepare("SELECT name, platform, last_seen_at FROM devices WHERE id = ?").bind(client.device_id),
    ),
  ]);
  const timestamp = now();
  return Response.json({
    messages: rows.results ?? [],
    cursor: rows.results?.at(-1)?.id ?? after,
    device: device
      // The agent heartbeats every 10s. Keep a wider window for sleeping
      // browser tabs and brief relay/network interruptions, without making a
      // genuinely stopped computer appear online indefinitely.
      ? { name: device.name, platform: device.platform, online: timestamp - device.last_seen_at < 180_000, lastSeenAt: device.last_seen_at }
      : null,
  });
}
