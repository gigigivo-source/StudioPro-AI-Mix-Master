import { buildPdfReport } from "../src/lib/exports";
import { type PcmData } from "../src/lib/client-audio-engine";

function makeSinePcm(durationSec: number, sampleRate = 44100): PcmData {
  const numSamples = Math.floor(durationSec * sampleRate);
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);
  return { sampleRate, channels: [left, right] };
}

try {
  const pcm = makeSinePcm(1.0);
  const doc = buildPdfReport({
    sourceName: "test_master.wav",
    settings: { genre: "POP", loudness: "SPOTIFY", intensity: 75, vocalFocus: true },
    trackCount: 4,
    durationSec: 60,
    sampleRate: 44100,
    elapsedSec: 1.2,
    before: { lufs: -18.2, truePeakDb: -3.5, dynamicRange: 12.0, stereoWidth: 45 },
    after: { lufs: -14.0, truePeakDb: -1.0, dynamicRange: 9.5, stereoWidth: 70 },
    originalPcm: pcm,
    masteredPcm: pcm,
  });

  const output = doc.output("arraybuffer");
  console.log("PDF Report generated successfully, size:", output.byteLength, "bytes");
} catch (err) {
  console.error("PDF generation failed:", err);
  process.exit(1);
}
