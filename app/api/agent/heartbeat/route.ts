import { authenticateAgent, jsonError, now, touchDevicePresence } from "../../_lib/store";

export async function POST(request: Request) {
  const agent = await authenticateAgent(request);
  if (!agent) return jsonError("设备认证失败", 401);
  const timestamp = now();
  await touchDevicePresence(agent.id, timestamp);
  return Response.json({ ok: true, at: timestamp });
}
