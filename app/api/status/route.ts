export async function GET() {
  return Response.json({ ok: true, service: "RelayDesk", version: "2026.10.28", time: Date.now() }, { headers: { "cache-control": "no-store" } });
}
