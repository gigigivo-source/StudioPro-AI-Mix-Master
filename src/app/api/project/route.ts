import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Local-first mode: no database, projects live in browser memory
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (id) {
    // In local-first mode, project details are held client-side
    return NextResponse.json({
      project: null,
      message: "Local-first mode: projects are stored in browser memory, not in database. Use upload response data.",
      mode: "local-first",
    });
  }

  // List recent projects - empty in local-first, client manages its own
  return NextResponse.json({
    projects: [],
    message: "Local-first mode: no database. Projects are managed in browser.",
    mode: "local-first",
  });
}
