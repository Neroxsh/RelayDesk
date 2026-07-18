export async function GET() {
  return Response.json({ ok: true, service: "RelayDesk", time: Date.now() });
}
