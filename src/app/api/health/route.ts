export const dynamic = "force-dynamic";

export async function GET() {
  // Local-first mode: no database required
  return Response.json({
    ok: true,
    mode: "local-first",
    database: "disabled",
    message: "App is running in browser-local mode, no database needed",
    timestamp: new Date().toISOString(),
  });
}
