import { NextRequest, NextResponse } from "next/server";
import { generateSynthesizedAudioWav } from "@/lib/audio-synth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = (searchParams.get("type") || "master") as "master" | "original";
    const genre = searchParams.get("genre") || "HIP_HOP";
    const bpm = parseFloat(searchParams.get("bpm") || "130");

    const buffer = generateSynthesizedAudioWav(type, genre, bpm, 14);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "public, max-age=3600, immutable",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error streaming audio";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
