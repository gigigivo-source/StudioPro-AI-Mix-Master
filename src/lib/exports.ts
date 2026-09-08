/**
 * exports.ts
 *
 * Download builders for the results dashboard. Everything is generated from
 * the user's own audio, locally, at download time.
 */

import JSZip from "jszip";
import { Mp3Encoder as LameMp3Encoder } from "@breezystack/lamejs";
import * as lameModule from "@breezystack/lamejs";
import { jsPDF } from "jspdf";

type Mp3EncoderCtor = new (
  channels: number,
  sampleRate: number,
  kbps: number
) => {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
};

/**
 * Resolve the LAME encoder across module interops.
 */
async function getMp3Encoder(): Promise<Mp3EncoderCtor> {
  if (typeof LameMp3Encoder === "function") {
    return LameMp3Encoder as unknown as Mp3EncoderCtor;
  }
  const ns = lameModule as unknown as {
    Mp3Encoder?: Mp3EncoderCtor;
    default?: { Mp3Encoder?: Mp3EncoderCtor };
  };
  if (typeof ns?.Mp3Encoder === "function") {
    return ns.Mp3Encoder;
  }
  if (typeof ns?.default?.Mp3Encoder === "function") {
    return ns.default.Mp3Encoder;
  }
  try {
    const dynamicMod = await import("@breezystack/lamejs");
    if (typeof dynamicMod.Mp3Encoder === "function") {
      return dynamicMod.Mp3Encoder as unknown as Mp3EncoderCtor;
    }
    if (typeof (dynamicMod as unknown as { default?: { Mp3Encoder?: Mp3EncoderCtor } }).default?.Mp3Encoder === "function") {
      return (dynamicMod as unknown as { default: { Mp3Encoder: Mp3EncoderCtor } }).default.Mp3Encoder;
    }
  } catch {
    /* fallback */
  }
  const globalMp3 =
    (globalThis as unknown as { Mp3Encoder?: Mp3EncoderCtor }).Mp3Encoder ??
    (globalThis as unknown as { lamejs?: { Mp3Encoder?: Mp3EncoderCtor } }).lamejs?.Mp3Encoder;
  if (typeof globalMp3 === "function") {
    return globalMp3;
  }

  throw new Error("MP3 encoder (lamejs) could not be loaded in this environment");
}

import {
  encodeWav,
  resample,
  renderToWav,
  type PcmData,
} from "./client-audio-engine";
import type { Metrics } from "./analysis";

/* ------------------------------------------------------------------ */

export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  return stem.replace(/[^\w\- ]+/g, "_").trim() || "master";
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ */
/* WAV                                                                 */
/* ------------------------------------------------------------------ */

export function wavBlob(pcm: PcmData, bitDepth: 16 | 24): Blob {
  return new Blob([encodeWav(pcm, bitDepth)], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ */
/* MP3 (320 kbps, LAME)                                                */
/* ------------------------------------------------------------------ */

const MP3_SUPPORTED_RATES = [44100, 48000, 22050, 24000, 11025, 12000];

/**
 * Encode PCM to MP3 (LAME, CBR). Chunked with yields so the UI stays
 * responsive on long tracks; progress via callback.
 */
export async function encodeMp3(
  pcm: PcmData,
  kbps = 320,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  let work = pcm;
  if (!MP3_SUPPORTED_RATES.includes(pcm.sampleRate)) {
    work = resample(pcm, 44100);
  }

  const channels = work.channels.length;
  const Encoder = await getMp3Encoder();
  const encoder = new Encoder(channels, work.sampleRate, kbps);
  const n = work.channels[0].length;
  const chunk = Math.max(1152, Math.floor(work.sampleRate * 0.25)); // 0.25 s

  const toI16 = (src: Float32Array): Int16Array => {
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      let v = Math.round(src[i] * 32767);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      out[i] = v;
    }
    return out;
  };

  const parts: BlobPart[] = [];
  for (let i = 0; i < n; i += chunk) {
    const end = Math.min(i + chunk, n);
    const left = toI16(work.channels[0].subarray(i, end));
    const right =
      channels > 1
        ? toI16(work.channels[1].subarray(i, end))
        : left;
    parts.push(encoder.encodeBuffer(left, right) as unknown as BlobPart);
    onProgress?.(Math.min(1, end / n));
    // Yield so the page can repaint (LAME is CPU-heavy).
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  parts.push(encoder.flush() as unknown as BlobPart);

  return new Blob(parts, { type: "audio/mpeg" });
}

/* ------------------------------------------------------------------ */
/* Stems ZIP                                                           */
/* ------------------------------------------------------------------ */

export interface StemTrack {
  name: string;
  buffer: AudioBuffer;
}

/**
 * Bundle every source track as its own 24-bit WAV into a single ZIP
 * (per-track WAVs, no re-mixing — the individual stems exactly as decoded).
 */
export async function buildStemsZip(
  tracks: StemTrack[],
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder("stems");
  if (!folder) throw new Error("Could not create ZIP folder");

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const blob = renderToWav(t.buffer, 24);
    const data = await blob.arrayBuffer();
    folder.file(`${String(i + 1).padStart(2, "0")}_${t.name}`, data);
    onProgress?.((i + 1) / tracks.length / 2); // encode half, zip half
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  const out = await zip.generateAsync(
    { type: "blob", compression: "STORE" },
    (meta) => onProgress?.(0.5 + (meta.percent / 100) * 0.5)
  );
  onProgress?.(1);
  return out;
}

/* ------------------------------------------------------------------ */
/* Waveform rendering (canvas) — used by the PDF report                */
/* ------------------------------------------------------------------ */

export interface WaveformArt {
  canvas?: HTMLCanvasElement;
  dataUrl: string;
}

/**
 * Draw a compact waveform of real PCM peaks onto a canvas.
 * Pure visualization of the supplied samples.
 */
export function renderWaveformCanvas(
  pcm: PcmData,
  opts: { width?: number; height?: number; bar?: string; bg?: string } = {}
): WaveformArt {
  const width = opts.width ?? 640;
  const height = opts.height ?? 112;

  if (typeof document === "undefined") {
    return { dataUrl: "" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, dataUrl: "" };

  ctx.fillStyle = opts.bg ?? "#12142a";
  ctx.fillRect(0, 0, width, height);

  const [l] = pcm.channels;
  const r = pcm.channels[1] ?? l;
  const n = l.length;
  const barW = 2;
  const gap = 1;
  const cols = Math.floor(width / (barW + gap));
  const step = Math.max(1, Math.floor(n / cols));
  const cy = height / 2;

  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, "#6C63FF");
  grad.addColorStop(1, "#00D4FF");
  ctx.fillStyle = grad;

  for (let c = 0; c < cols; c++) {
    const start = c * step;
    const end = Math.min(start + step, n);
    let peak = 0;
    for (let i = start; i < end; i += 4) {
      const a = Math.abs(l[i]);
      const b = Math.abs(r[i]);
      if (a > peak) peak = a;
      else if (b > peak) peak = b;
    }
    const h = Math.max(2, Math.min(1, peak) * (height - 16));
    ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, peak);
    ctx.fillRect(c * (barW + gap), cy - h / 2, barW, h);
  }
  ctx.globalAlpha = 1;

  // Center line
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(0, cy - 0.5, width, 1);

  return { canvas, dataUrl: canvas.toDataURL("image/png") };
}

/* ------------------------------------------------------------------ */
/* PDF report                                                          */
/* ------------------------------------------------------------------ */

export interface ReportParams {
  sourceName: string;
  settings: { genre: string; loudness: string; intensity: number; vocalFocus: boolean };
  trackCount: number;
  durationSec: number;
  sampleRate: number;
  elapsedSec: number;
  before: Metrics;
  after: Metrics;
  originalPcm: PcmData;
  masteredPcm: PcmData;
}

const ACCENT: [number, number, number] = [108, 99, 255];
const AQUA: [number, number, number] = [0, 212, 255];
const INK: [number, number, number] = [20, 22, 43];
const MUT: [number, number, number] = [104, 108, 138];

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function buildPdfReport(p: ReportParams): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(); // 595.28
  const M = 40; // margin

  // ---- Header band ----
  doc.setFillColor(13, 15, 30);
  doc.rect(0, 0, W, 96, "F");

  // Decorative waveform bars (visual, not data).
  const bars = 46;
  for (let i = 0; i < bars; i++) {
    const h = 8 + 26 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21));
    const t = i / bars;
    const rr = Math.round(ACCENT[0] + (AQUA[0] - ACCENT[0]) * t);
    const gg = Math.round(ACCENT[1] + (AQUA[1] - ACCENT[1]) * t);
    const bb = Math.round(ACCENT[2] + (AQUA[2] - ACCENT[2]) * t);
    doc.setFillColor(rr, gg, bb);
    doc.roundedRect(M + i * 10.5, 52 - h / 2, 3.4, h, 1.6, 1.6, "F");
  }

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("StudioPro", M, 32);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(143, 148, 255);
  doc.text("P R O F E S S I O N A L   M A S T E R I N G   R E P O R T", M, 78);

  doc.setFontSize(8);
  doc.setTextColor(154, 160, 195);
  const dateStr = new Date().toLocaleString();
  doc.text(dateStr, W - M, 32, { align: "right" });
  doc.text(p.sourceName, W - M, 44, { align: "right", maxWidth: 260 });

  // ---- Session settings ----
  let y = 128;
  doc.setTextColor(...ACCENT);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("SESSION", M, y);
  y += 16;

  doc.setDrawColor(226, 228, 240);
  doc.setLineWidth(0.6);

  const rows: [string, string, string, string][] = [
    ["Genre profile", p.settings.genre.replace(/_/g, " "), "Loudness target", p.settings.loudness.replace(/_/g, " ")],
    ["Mixing intensity", `${p.settings.intensity}%`, "Vocal focus", p.settings.vocalFocus ? "On" : "Off"],
    ["Tracks summed", String(p.trackCount), "Master duration", fmtDur(p.durationSec)],
    ["Sample rate", `${(p.sampleRate / 1000).toFixed(1)} kHz`, "Render time", `${p.elapsedSec.toFixed(1)} s`],
  ];

  doc.setFontSize(8.5);
  for (const [l1, v1, l2, v2] of rows) {
    doc.setTextColor(...MUT);
    doc.setFont("helvetica", "normal");
    doc.text(l1, M, y);
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.text(v1, M + 110, y);
    doc.setTextColor(...MUT);
    doc.setFont("helvetica", "normal");
    doc.text(l2, M + 270, y);
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.text(v2, M + 380, y);
    doc.line(M, y + 7, W - M, y + 7);
    y += 22;
  }

  // ---- Loudness analysis table ----
  y += 14;
  doc.setTextColor(...ACCENT);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("LOUDNESS ANALYSIS", M, y);
  y += 14;

  const colB = M + 230;
  const colA = M + 320;
  const colD = M + 415;

  doc.setFillColor(238, 240, 248);
  doc.rect(M, y, W - 2 * M, 20, "F");
  doc.setFontSize(8);
  doc.setTextColor(...MUT);
  doc.text("METRIC", M + 8, y + 13);
  doc.text("BEFORE", colB + 8, y + 13);
  doc.text("AFTER", colA + 8, y + 13);
  doc.text("CHANGE", colD + 8, y + 13);
  y += 20;

  const metric = (name: string, before: string, after: string, delta: string, deltaColor: [number, number, number]) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(name, M + 8, y + 13);
    doc.setTextColor(...MUT);
    doc.text(before, colB + 8, y + 13);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...INK);
    doc.text(after, colA + 8, y + 13);
    doc.setTextColor(...deltaColor);
    doc.text(delta, colD + 8, y + 13);
    doc.setDrawColor(238, 240, 248);
    doc.line(M, y + 20, W - M, y + 20);
    y += 22;
  };

  const lufsd = p.after.lufs - p.before.lufs;
  const tpd = p.after.truePeakDb - p.before.truePeakDb;
  const drd = p.after.dynamicRange - p.before.dynamicRange;
  const wd = p.after.stereoWidth - p.before.stereoWidth;

  metric(
    "Integrated loudness (LUFS)",
    `${p.before.lufs.toFixed(1)}`,
    `${p.after.lufs.toFixed(1)}`,
    `${lufsd >= 0 ? "+" : "−"}${Math.abs(lufsd).toFixed(1)}`,
    lufsd >= 0 ? ACCENT : MUT
  );
  metric(
    "True peak (dBTP)",
    `${p.before.truePeakDb.toFixed(1)}`,
    `${p.after.truePeakDb.toFixed(1)}`,
    `${tpd >= 0 ? "+" : "−"}${Math.abs(tpd).toFixed(1)}`,
    AQUA
  );
  metric(
    "Dynamic range (dB)",
    `${p.before.dynamicRange.toFixed(1)}`,
    `${p.after.dynamicRange.toFixed(1)}`,
    `${drd >= 0 ? "+" : "−"}${Math.abs(drd).toFixed(1)}`,
    MUT
  );
  metric(
    "Stereo width (%)",
    `${p.before.stereoWidth}`,
    `${p.after.stereoWidth}`,
    `${wd >= 0 ? "+" : "−"}${Math.abs(wd)}`,
    ACCENT
  );

  // ---- Waveforms (if in browser) ----
  const imgW = W - 2 * M;
  const imgH = 88;
  const origArt = renderWaveformCanvas(p.originalPcm, { width: 1100, height: 140 });
  const mastArt = renderWaveformCanvas(p.masteredPcm, { width: 1100, height: 140 });

  if (origArt.dataUrl && mastArt.dataUrl) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...ACCENT);
    doc.text("WAVEFORM — ORIGINAL", M, y + 10);
    doc.addImage(origArt.dataUrl, "PNG", M, y + 16, imgW, imgH);
    y += 16 + imgH + 26;

    doc.text("WAVEFORM — MASTERED", M, y - 10);
    doc.addImage(mastArt.dataUrl, "PNG", M, y, imgW, imgH);
    y += imgH + 30;
  } else {
    y += 20;
  }

  // ---- Processing chain ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...ACCENT);
  doc.text("PROCESSING CHAIN", M, y);
  y += 16;

  const chain = [
    "High-pass filter @ 20 Hz (DC offset & sub-rumble removal)",
    `Genre EQ — ${p.settings.genre.replace(/_/g, " ")} profile (low shelf, low-mid carve, presence, air)`,
    ...(p.settings.vocalFocus ? ["Vocal focus — +2.2 dB presence lift @ 3 kHz, low-mid carve"] : []),
    "Mid/side processing — mono low-end, stereo widening",
    "Analog-style soft saturation + bus compression (soft-knee)",
    `Loudness normalization to ${p.settings.loudness.replace(/_/g, " ")} target (ITU-R BS.1770-4, gated)`,
    "True-peak ceiling @ −1.0 dBTP (4x oversampled detection, transparent limiter)",
  ];

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  for (const line of chain) {
    doc.setFillColor(...ACCENT);
    doc.circle(M + 2, y - 2.5, 1.6, "F");
    doc.setTextColor(...INK);
    doc.text(line, M + 12, y, { maxWidth: W - 2 * M - 12 });
    y += 15;
  }

  // ---- Footer ----
  doc.setDrawColor(226, 228, 240);
  doc.line(M, 806, W - M, 806);
  doc.setFontSize(7.5);
  doc.setTextColor(...MUT);
  doc.text(
    "Rendered entirely in your browser — no audio left this device. · StudioPro Mix & Master",
    M,
    820
  );
  doc.text("Generated " + dateStr, W - M, 820, { align: "right" });

  return doc;
}
