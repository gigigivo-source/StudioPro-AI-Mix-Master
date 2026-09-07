import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (id) {
      const [proj] = await db.select().from(projects).where(eq(projects.id, id));
      if (!proj) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      return NextResponse.json({ project: proj });
    }

    // List recent projects
    const list = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(10);
    return NextResponse.json({ projects: list });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error fetching project";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
