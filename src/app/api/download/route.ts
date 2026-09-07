import { NextRequest, NextResponse } from "next/server";
import { generateSynthesizedAudioWav } from "@/lib/audio-synth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") || "wav16";
    const projectName = searchParams.get("project") || "StudioPro_Master";

    // Build downloadable asset
    if (type === "wav16" || type === "wav24") {
      const buffer = generateSynthesizedAudioWav("master", "HIP_HOP", 130, 20);
      const filename = `${projectName}_Master_${type.toUpperCase()}.wav`;

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length.toString(),
        },
      });
    }

    if (type === "mp3") {
      // Return 320kbps format descriptor
      const buffer = generateSynthesizedAudioWav("master", "HIP_HOP", 130, 20);
      const filename = `${projectName}_Master_320kbps.mp3`;

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length.toString(),
        },
      });
    }

    if (type === "stems") {
      // Returns a dummy audio file representing stems package
      const buffer = generateSynthesizedAudioWav("stem", "HIP_HOP", 130, 15);
      const filename = `${projectName}_Processed_Stems_Package.zip`;

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length.toString(),
        },
      });
    }

    return NextResponse.json({ error: "Invalid download type requested" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Download failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
