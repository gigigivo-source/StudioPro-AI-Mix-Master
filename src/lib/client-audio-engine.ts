/**
 * client-audio-engine.ts
 *
 * 100% client-side mixing & mastering engine.
 *
 * This module contains NO synthesis and NO demo/placeholder audio of any kind.
 * Every output sample is derived from the user's own decoded audio. If no audio
 * is supplied, the functions throw rather than inventing a beat.
 *
 * Signal chain (per segment, state carried across segments):
 *   1. DC / sub-rumble high-pass (18-25 Hz)
 *   2. Genre EQ: low shelf, mud cut, presence peaking, air shelf
 *   3. Optional vocal focus (presence lift + mud carve)
 *   4. Mid/Side: mono-collapse lows, stereo widening
 *   5. Analog-style soft saturation (tanh), scaled by intensity
 *   6. Bus compression (RMS envelope, soft knee)
 *   7. Measured loudness normalization to target LUFS (ITU-R BS.1770-4 approximation, gated)
 *   8. True-peak ceiling (4x oversampled detection) + transparent brickwall
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Raw PCM, channels as Float32Array in [-1, 1]. */
export interface PcmData {
  sampleRate: number;
  channels: Float32Array[];
}

export interface MasterOptions {
  genre: string;
  loudness: string;
  /** 0 - 100 */
  intensity: number;
  vocalFocus: boolean;
  /** Optional 0..1 progress callback. */
  onProgress?: (fraction: number) => void;
}

export interface AudioTrackInput {
  fileName: string;
  /** WAV (or other PCM container understood by parseWav) bytes. */
  data: ArrayBuffer;
  isUserUploaded?: boolean;
}

export interface DecodedTrackInput {
  fileName: string;
  buffer: AudioBuffer;
  isUserUploaded?: boolean;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const LOUDNESS_TARGETS: Record<string, number> = {
  SPOTIFY: -14.0,
  APPLE_MUSIC: -16.0,
  YOUTUBE: -14.0,
  CD: -9.0,
  // Legacy aliases
  LOW: -16.0,
  MEDIUM: -14.0,
  HIGH: -9.0,
};

const DEFAULT_TARGET_LUFS = -14.0;
const TRUE_PEAK_CEILING_DBTP = -1.0;

interface GenreProfile {
  lowShelf: { freq: number; gain: number };
  mudCut: { freq: number; q: number; gain: number };
  presence: { freq: number; q: number; gain: number };
  highShelf: { freq: number; gain: number };
  /** Compressor ratio at full intensity. */
  ratio: number;
  /** Saturation drive at full intensity. */
  saturation: number;
  /** Stereo width multiplier at full intensity. */
  width: number;
  /** How much low-end side information to collapse (0..1). */
  monoCollapse: number;
}

const GENRE_PROFILES: Record<string, GenreProfile> = {
  POP: {
    lowShelf: { freq: 80, gain: 1.5 },
    mudCut: { freq: 250, q: 0.9, gain: -1.0 },
    presence: { freq: 3500, q: 0.9, gain: 2.0 },
    highShelf: { freq: 8000, gain: 2.5 },
    ratio: 3.0,
    saturation: 0.15,
    width: 1.08,
    monoCollapse: 0.85,
  },
  HIP_HOP: {
    lowShelf: { freq: 60, gain: 4.0 },
    mudCut: { freq: 200, q: 1.0, gain: -1.5 },
    presence: { freq: 3000, q: 0.9, gain: 1.5 },
    highShelf: { freq: 9000, gain: 1.5 },
    ratio: 4.0,
    saturation: 0.25,
    width: 1.0,
    monoCollapse: 1.0,
  },
  EDM: {
    lowShelf: { freq: 55, gain: 3.5 },
    mudCut: { freq: 300, q: 1.0, gain: -2.0 },
    presence: { freq: 5000, q: 0.8, gain: 2.0 },
    highShelf: { freq: 10000, gain: 3.5 },
    ratio: 4.5,
    saturation: 0.2,
    width: 1.15,
    monoCollapse: 1.0,
  },
  ROCK: {
    lowShelf: { freq: 90, gain: 1.0 },
    mudCut: { freq: 400, q: 1.0, gain: -1.5 },
    presence: { freq: 2500, q: 0.9, gain: 2.0 },
    highShelf: { freq: 7000, gain: 2.0 },
    ratio: 5.0,
    saturation: 0.3,
    width: 1.05,
    monoCollapse: 0.8,
  },
  ACOUSTIC: {
    lowShelf: { freq: 70, gain: 0.5 },
    mudCut: { freq: 300, q: 0.8, gain: -1.0 },
    presence: { freq: 2500, q: 0.8, gain: 1.0 },
    highShelf: { freq: 8000, gain: 1.5 },
    ratio: 2.0,
    saturation: 0.08,
    width: 1.1,
    monoCollapse: 0.7,
  },
  CLASSICAL: {
    lowShelf: { freq: 60, gain: 0.5 },
    mudCut: { freq: 250, q: 0.7, gain: -0.5 },
    presence: { freq: 2000, q: 0.7, gain: 0.5 },
    highShelf: { freq: 9000, gain: 1.5 },
    ratio: 1.5,
    saturation: 0.03,
    width: 1.15,
    monoCollapse: 0.5,
  },
  JAZZ: {
    lowShelf: { freq: 70, gain: 1.0 },
    mudCut: { freq: 300, q: 0.8, gain: -0.5 },
    presence: { freq: 2000, q: 0.8, gain: 1.0 },
    highShelf: { freq: 8000, gain: 1.5 },
    ratio: 2.0,
    saturation: 0.08,
    width: 1.12,
    monoCollapse: 0.6,
  },
  METAL: {
    lowShelf: { freq: 100, gain: 1.0 },
    mudCut: { freq: 500, q: 1.1, gain: -2.5 },
    presence: { freq: 3000, q: 0.9, gain: 2.5 },
    highShelf: { freq: 7000, gain: 2.0 },
    ratio: 6.0,
    saturation: 0.35,
    width: 1.05,
    monoCollapse: 0.9,
  },
  R_AND_B: {
    lowShelf: { freq: 60, gain: 3.0 },
    mudCut: { freq: 250, q: 0.9, gain: -1.0 },
    presence: { freq: 3500, q: 0.9, gain: 2.0 },
    highShelf: { freq: 9000, gain: 2.0 },
    ratio: 3.5,
    saturation: 0.18,
    width: 1.06,
    monoCollapse: 0.9,
  },
  LO_FI: {
    lowShelf: { freq: 80, gain: 2.0 },
    mudCut: { freq: 400, q: 0.9, gain: -1.0 },
    presence: { freq: 2000, q: 0.8, gain: -1.0 },
    highShelf: { freq: 6000, gain: -3.0 },
    ratio: 3.0,
    saturation: 0.3,
    width: 0.95,
    monoCollapse: 0.9,
  },
};

/* ------------------------------------------------------------------ *
 * WAV decoding
 * ------------------------------------------------------------------ */

/**
 * Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit int and 32/64-bit float,
 * any channel count. Unknown/optional chunks are skipped.
 */
export function parseWav(arrayBuffer: ArrayBuffer): PcmData {
  const view = new DataView(arrayBuffer);
  const readTag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );

  // Tolerate an optional ID3v2 tag in front of the RIFF block.
  let riffStart = 0;
  if (arrayBuffer.byteLength >= 10 && readTag(0).slice(0, 3) === "ID3") {
    const id3Size =
      ((view.getUint8(6) & 0x7f) << 21) |
      ((view.getUint8(7) & 0x7f) << 14) |
      ((view.getUint8(8) & 0x7f) << 7) |
      (view.getUint8(9) & 0x7f);
    riffStart = 10 + id3Size;
  }
  if (arrayBuffer.byteLength < riffStart + 12) {
    throw new Error("File too small to be a WAV");
  }
  if (readTag(riffStart) !== "RIFF" || readTag(riffStart + 8) !== "WAVE") {
    throw new Error("Not a valid RIFF/WAVE file");
  }

  let offset = riffStart + 12;
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readTag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (chunkId === "fmt " && body + 16 <= view.byteLength) {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = Math.min(chunkSize, view.byteLength - body);
    }

    // Chunks are word-aligned.
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (format === 0) throw new Error("WAV missing fmt chunk");
  if (dataOffset < 0) throw new Error("WAV missing data chunk");
  if (numChannels <= 0) throw new Error("WAV has zero channels");
  if (sampleRate <= 0) throw new Error("WAV has invalid sample rate");

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  if (frameSize <= 0) throw new Error("WAV has invalid bit depth");

  const totalFrames = Math.floor(dataLength / frameSize);
  if (totalFrames <= 0) throw new Error("WAV contains no audio frames");

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(totalFrames));

  const isFloat = format === 3 || format === 0xfffe;
  let pos = dataOffset;

  for (let i = 0; i < totalFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = 0;
      if (bitsPerSample === 8) {
        // 8-bit WAV is unsigned
        sample = (view.getUint8(pos) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        sample = v / 8388608;
      } else if (bitsPerSample === 32) {
        if (isFloat) {
          sample = view.getFloat32(pos, true);
        } else {
          sample = view.getInt32(pos, true) / 2147483648;
        }
      } else if (bitsPerSample === 64) {
        sample = view.getFloat64(pos, true);
      } else {
        throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
      }
      channels[c][i] = sample;
      pos += bytesPerSample;
    }
  }

  return { sampleRate, channels };
}

/* ------------------------------------------------------------------ *
 * WAV encoding
 * ------------------------------------------------------------------ */

export function encodeWav(pcm: PcmData, bitDepth: 16 | 24 | 32 = 24): ArrayBuffer {
  const numChannels = pcm.channels.length;
  if (numChannels === 0) throw new Error("No channels to encode");
  const numFrames = pcm.channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeTag(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const clamp = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = clamp(pcm.channels[c][i] || 0);
      if (bitDepth === 16) {
        view.setInt16(offset, Math.round(s * 32767), true);
        offset += 2;
      } else if (bitDepth === 24) {
        let v = Math.round(s * 8388607);
        if (v > 8388607) v = 8388607;
        if (v < -8388608) v = -8388608;
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      } else {
        view.setFloat32(offset, s, true);
        offset += 4;
      }
    }
  }

  return buffer;
}

/** Encode an AudioBuffer to a WAV Blob. */
export function renderToWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32 = 24): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    // Copy: getChannelData returns a live view in some engines.
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  const pcm: PcmData = { sampleRate: buffer.sampleRate, channels };
  return new Blob([encodeWav(pcm, bitDepth)], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

const dbToGain = (db: number) => Math.pow(10, db / 20);
const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));

/** Linear-interpolation resampler. */
export function resample(pcm: PcmData, targetRate: number): PcmData {
  if (pcm.sampleRate === targetRate) return pcm;
  const ratio = pcm.sampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(pcm.channels[0].length / ratio));
  const channels = pcm.channels.map((input) => {
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = srcPos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  });
  return { sampleRate: targetRate, channels };
}

/** Force to exactly 2 channels (mono duplicated, >2 downmixed). */
export function toStereo(pcm: PcmData): PcmData {
  if (pcm.channels.length === 2) return pcm;
  if (pcm.channels.length === 1) {
    return { sampleRate: pcm.sampleRate, channels: [pcm.channels[0], pcm.channels[0]] };
  }
  const n = pcm.channels[0].length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let c = 0; c < pcm.channels.length; c++) {
    const ch = pcm.channels[c];
    // Alternate channels across L/R for multichannel downmix.
    const target = c % 2 === 0 ? left : right;
    for (let i = 0; i < n; i++) target[i] += ch[i];
  }
  const pairs = Math.max(1, Math.ceil(pcm.channels.length / 2));
  for (let i = 0; i < n; i++) {
    left[i] /= pairs;
    right[i] /= pairs;
  }
  return { sampleRate: pcm.sampleRate, channels: [left, right] };
}

/** Deep-copy a PCM (independent channel arrays) — used for A/B work copies. */
export function clonePcm(pcm: PcmData): PcmData {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => new Float32Array(c)),
  };
}

/**
 * Sum tracks into one stereo PCM. Resamples to the highest input rate and pads
 * shorter tracks with silence so nothing is truncated.
 */
export function sumTracks(tracks: PcmData[]): PcmData {
  if (tracks.length === 0) throw new Error("No tracks to sum");

  const targetRate = Math.max(...tracks.map((t) => t.sampleRate));
  const stereo = tracks.map((t) => toStereo(resample(t, targetRate)));
  const length = Math.max(...stereo.map((t) => t.channels[0].length));

  // Memory fast path: summing a single track is an identity op (gain = 1/√1),
  // so when it is already stereo at the target rate we return it in place
  // instead of allocating a full second copy of the audio. This halves the
  // pipeline's peak memory for single-file projects.
  if (stereo.length === 1 && stereo[0] === tracks[0]) {
    return stereo[0];
  }

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // Headroom trim so summing N tracks does not slam the bus.
  const gain = 1 / Math.sqrt(stereo.length);

  for (const t of stereo) {
    const l = t.channels[0];
    const r = t.channels[1];
    for (let i = 0; i < l.length; i++) left[i] += l[i] * gain;
    for (let i = 0; i < r.length; i++) right[i] += r[i] * gain;
  }

  return { sampleRate: targetRate, channels: [left, right] };
}

/* ------------------------------------------------------------------ *
 * Biquad filters (RBJ cookbook, Direct Form I, stateful across segments)
 * ------------------------------------------------------------------ */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function makeBiquad(
  type: "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking",
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number
): Biquad {
  const f = Math.min(Math.max(freq, 10), sampleRate * 0.49);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = Math.sin(w0) / (2 * Math.max(q, 1e-6));

  let b0 = 0,
    b1 = 0,
    b2 = 0,
    a0 = 0,
    a1 = 0,
    a2 = 0;

  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "lowshelf": {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - sq);
      a0 = A + 1 + (A - 1) * cos + sq;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - sq;
      break;
    }
    case "highshelf": {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - sq);
      a0 = A + 1 - (A - 1) * cos + sq;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - sq;
      break;
    }
    case "peaking":
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function biquadProcess(f: Biquad, data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1;
    f.x1 = x;
    f.y2 = f.y1;
    f.y1 = y;
    data[i] = y;
  }
}

function makeBiquadPair(
  type: "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking",
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number
): [Biquad, Biquad] {
  return [makeBiquad(type, freq, q, gainDb, sampleRate), makeBiquad(type, freq, q, gainDb, sampleRate)];
}

/* ------------------------------------------------------------------ *
 * Loudness measurement (ITU-R BS.1770-4 approximation, gated)
 * ------------------------------------------------------------------ */

function kWeightFilters(sampleRate: number) {
  return {
    // Stage 1: high shelf +4 dB @ ~1682 Hz
    shelf: makeBiquad("highshelf", 1681.97, 0.7071, 4.0, sampleRate),
    // Stage 2: RLB high-pass @ 38 Hz
    hpf: makeBiquad("highpass", 38.13, 0.5, 0, sampleRate),
  };
}

export function measureLufs(pcm: PcmData): number {
  const sampleRate = pcm.sampleRate;
  const blockSize = Math.max(1, Math.floor(sampleRate * 0.4));
  const channels = pcm.channels;
  const length = channels[0].length;
  const numBlocks = Math.ceil(length / blockSize);
  if (numBlocks === 0) return -120;

  const filters = channels.map(() => kWeightFilters(sampleRate));
  const blockPowers: number[] = [];

  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    const end = Math.min(start + blockSize, length);
    let sum = 0;

    for (let c = 0; c < channels.length; c++) {
      const seg = channels[c].subarray(start, end);
      const work = new Float32Array(seg); // copy so we don't mutate the source
      biquadProcess(filters[c].shelf, work);
      biquadProcess(filters[c].hpf, work);
      let chSum = 0;
      for (let i = 0; i < work.length; i++) chSum += work[i] * work[i];
      sum += chSum / work.length;
    }

    blockPowers.push(sum);
  }

  const blockLufs = blockPowers.map((p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-20)));

  // Absolute gate: -70 LUFS
  const gated1 = blockLufs.map((l, i) => (l > -70 ? blockPowers[i] : -1)).filter((p) => p >= 0);
  if (gated1.length === 0) return -120;

  const mean1 = gated1.reduce((a, b) => a + b, 0) / gated1.length;
  const relativeThreshold = -0.691 + 10 * Math.log10(Math.max(mean1, 1e-20)) - 10;

  // Relative gate: -10 LU below the absolute-gated mean
  const gated2 = blockLufs
    .map((l, i) => (l > -70 && l > relativeThreshold ? blockPowers[i] : -1))
    .filter((p) => p >= 0);
  if (gated2.length === 0) return -120;

  const mean2 = gated2.reduce((a, b) => a + b, 0) / gated2.length;
  return -0.691 + 10 * Math.log10(Math.max(mean2, 1e-20));
}

/** True peak via 4x oversampling (linear interpolation). Returns linear amplitude. */
export function measureTruePeak(pcm: PcmData): number {
  const OS = 4;
  let peak = 0;
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length - 1; i++) {
      const a = ch[i];
      const b = ch[i + 1];
      const aAbs = Math.abs(a);
      if (aAbs > peak) peak = aAbs;
      for (let k = 1; k < OS; k++) {
        const t = k / OS;
        const v = Math.abs(a + (b - a) * t);
        if (v > peak) peak = v;
      }
    }
    const last = Math.abs(ch[ch.length - 1] || 0);
    if (last > peak) peak = last;
  }
  return peak;
}

/* ------------------------------------------------------------------ *
 * The mastering chain (stateful, processes segment-by-segment)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Mastering pipeline
 * ------------------------------------------------------------------ */

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function resolveProfile(genre: string): GenreProfile {
  const key = (genre || "").toUpperCase();
  return GENRE_PROFILES[key] || GENRE_PROFILES.POP;
}

function resolveTargetLufs(loudness: string): number {
  const key = (loudness || "").toUpperCase();
  return LOUDNESS_TARGETS[key] ?? DEFAULT_TARGET_LUFS;
}

/**
 * Saturate + compress + EQ a stereo PCM (in place), segment by segment so the
 * browser can repaint and report progress.
 */
async function applyToneAndDynamics(
  pcm: PcmData,
  profile: GenreProfile,
  intensity: number,
  vocalFocus: boolean,
  onProgress?: (fraction: number) => void,
  progressStart = 0,
  progressSpan = 1
): Promise<void> {
  const sampleRate = pcm.sampleRate;
  const k = Math.min(Math.max(intensity, 0), 100) / 100;
  const left = pcm.channels[0];
  const right = pcm.channels[1];
  const length = left.length;
  if (length === 0) throw new Error("Audio contains no samples");

  // --- Filters (stateful across segments) ---
  const hpfL = makeBiquad("highpass", 20, 0.707, 0, sampleRate);
  const hpfR = makeBiquad("highpass", 20, 0.707, 0, sampleRate);
  const lowShelfL = makeBiquad("lowshelf", profile.lowShelf.freq, 0.707, profile.lowShelf.gain * k, sampleRate);
  const lowShelfR = makeBiquad("lowshelf", profile.lowShelf.freq, 0.707, profile.lowShelf.gain * k, sampleRate);
  const mudL = makeBiquad(
    "peaking",
    profile.mudCut.freq,
    profile.mudCut.q,
    profile.mudCut.gain * k - (vocalFocus ? 0.8 * k : 0),
    sampleRate
  );
  const mudR = makeBiquad(
    "peaking",
    profile.mudCut.freq,
    profile.mudCut.q,
    profile.mudCut.gain * k - (vocalFocus ? 0.8 * k : 0),
    sampleRate
  );
  const presL = makeBiquad("peaking", profile.presence.freq, profile.presence.q, profile.presence.gain * k, sampleRate);
  const presR = makeBiquad("peaking", profile.presence.freq, profile.presence.q, profile.presence.gain * k, sampleRate);
  const airL = makeBiquad("highshelf", profile.highShelf.freq, 0.707, profile.highShelf.gain * k, sampleRate);
  const airR = makeBiquad("highshelf", profile.highShelf.freq, 0.707, profile.highShelf.gain * k, sampleRate);
  const voxL = makeBiquad("peaking", 3000, 0.9, vocalFocus ? 2.2 * k : 0, sampleRate);
  const voxR = makeBiquad("peaking", 3000, 0.9, vocalFocus ? 2.2 * k : 0, sampleRate);
  const sideLpL = makeBiquad("lowpass", 120, 0.707, 0, sampleRate);

  // --- Dynamics ---
  const drive = profile.saturation * k;
  const ratio = 1 + (profile.ratio - 1) * k;
  const thresholdDb = -18 + 6 * (1 - k);
  const attackCoef = Math.exp(-1 / (0.003 * sampleRate));
  const releaseCoef = Math.exp(-1 / (0.12 * sampleRate));
  const width = 1 + (profile.width - 1) * k;
  const monoCollapse = profile.monoCollapse * k;
  const kneeDb = 6;
  let envelope = 0;

  const segmentSize = Math.max(1, Math.floor(sampleRate * 0.25));
  const sideBuffer = new Float32Array(segmentSize);
  let processed = 0;

  for (let start = 0; start < length; start += segmentSize) {
    const end = Math.min(start + segmentSize, length);
    const n = end - start;
    const lSeg = left.subarray(start, end);
    const rSeg = right.subarray(start, end);

    // 1. High-pass (DC / sub rumble)
    biquadProcess(hpfL, lSeg);
    biquadProcess(hpfR, rSeg);

    // 2. Genre EQ
    biquadProcess(lowShelfL, lSeg);
    biquadProcess(lowShelfR, rSeg);
    biquadProcess(mudL, lSeg);
    biquadProcess(mudR, rSeg);
    biquadProcess(presL, lSeg);
    biquadProcess(presR, rSeg);
    biquadProcess(airL, lSeg);
    biquadProcess(airR, rSeg);

    // 3. Vocal presence lift
    if (vocalFocus) {
      biquadProcess(voxL, lSeg);
      biquadProcess(voxR, rSeg);
    }

    // 4. Mid/Side: collapse lows, widen
    const side = sideBuffer.subarray(0, n);
    for (let i = 0; i < n; i++) side[i] = (lSeg[i] - rSeg[i]) * 0.5;
    biquadProcess(sideLpL, side);
    for (let i = 0; i < n; i++) {
      const mid = (lSeg[i] + rSeg[i]) * 0.5;
      const s = (lSeg[i] - rSeg[i]) * 0.5;
      const collapsed = s - side[i] * monoCollapse;
      const widened = collapsed * width;
      lSeg[i] = mid + widened;
      rSeg[i] = mid - widened;
    }

    // 5 + 6. Saturation and bus compression
    for (let i = 0; i < n; i++) {
      // Soft saturation
      let l = lSeg[i];
      let r = rSeg[i];
      if (drive > 0) {
        const d = 1 + drive * 3;
        l = Math.tanh(l * d) / Math.tanh(d);
        r = Math.tanh(r * d) / Math.tanh(d);
      }

      // Compression: shared stereo envelope so imaging stays stable.
      const rect = Math.max(Math.abs(l), Math.abs(r));
      const coef = rect > envelope ? attackCoef : releaseCoef;
      envelope = coef * envelope + (1 - coef) * rect;
      const levelDb = gainToDb(envelope);

      let gainDb = 0;
      if (levelDb > thresholdDb - kneeDb / 2) {
        const overshoot = levelDb - thresholdDb;
        if (overshoot > kneeDb / 2) {
          gainDb = -(overshoot - kneeDb / 2) * (1 - 1 / ratio) - (kneeDb / 2) * (1 - 1 / ratio) * 0.5;
        } else {
          // Soft knee: quadratic ramp into full compression
          const x = overshoot + kneeDb / 2; // 0..kneeDb
          gainDb = -((1 - 1 / ratio) * x * x) / (2 * kneeDb);
        }
      }
      const g = dbToGain(gainDb);
      lSeg[i] = l * g;
      rSeg[i] = r * g;
    }

    processed += n;
    onProgress?.(progressStart + progressSpan * (processed / length));
    await yieldToUi();
  }
}

/** Apply a linear gain to every channel, in place. */
async function applyGain(
  pcm: PcmData,
  gainLinear: number,
  onProgress?: (fraction: number) => void,
  progressStart = 0,
  progressSpan = 1
): Promise<void> {
  const channels = pcm.channels;
  const length = channels[0].length;
  const segmentSize = 262144;
  let processed = 0;

  for (let start = 0; start < length; start += segmentSize) {
    const end = Math.min(start + segmentSize, length);
    for (const ch of channels) {
      for (let i = start; i < end; i++) ch[i] *= gainLinear;
    }
    processed += end - start;
    onProgress?.(progressStart + progressSpan * (processed / length));
    await yieldToUi();
  }
}

/**
 * Soft-limit transients above `level`: y = level * tanh(x / level).
 * Transparent for material well below `level`; shaves only the transients that
 * would otherwise force the whole master to be turned down.
 */
async function softLimit(pcm: PcmData, level: number): Promise<void> {
  if (!Number.isFinite(level) || level <= 0) return;
  const channels = pcm.channels;
  const length = channels[0].length;
  const segmentSize = 262144;

  for (let start = 0; start < length; start += segmentSize) {
    const end = Math.min(start + segmentSize, length);
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        ch[i] = level * Math.tanh(ch[i] / level);
      }
    }
    await yieldToUi();
  }
}

/** Hard safety clamp — a no-op whenever the gain maths already held the ceiling. */
function clampToCeiling(pcm: PcmData, ceilingLinear: number): void {
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (ch[i] > ceilingLinear) ch[i] = ceilingLinear;
      else if (ch[i] < -ceilingLinear) ch[i] = -ceilingLinear;
    }
  }
}

/**
 * Bring the master to the target integrated loudness without exceeding the
 * true-peak ceiling.
 *
 * A pure linear gain scales true peak exactly, so once we know the measured
 * true peak we can hit the ceiling precisely without any nonlinear squashing.
 * A limiter is only engaged when the loudness target would otherwise push peaks
 * past the ceiling (i.e. the material is peak-bound).
 */
async function normalizeLoudness(
  pcm: PcmData,
  targetLufs: number,
  onProgress?: (fraction: number) => void,
  progressStart = 0,
  progressSpan = 1
): Promise<void> {
  const ceilingLinear = dbToGain(TRUE_PEAK_CEILING_DBTP);
  const iterations = 3;

  for (let iter = 0; iter < iterations; iter++) {
    const before = progressStart + progressSpan * (iter / iterations);
    const span = progressSpan / iterations;

    // Gain needed to reach the loudness target.
    const lufs = measureLufs(pcm);
    let gain = dbToGain(Math.max(-24, Math.min(24, targetLufs - lufs)));

    // If that gain would breach the ceiling, limit transients first so the
    // master can still reach (or approach) the target loudness.
    const truePeak = measureTruePeak(pcm);
    if (truePeak > 0 && truePeak * gain > ceilingLinear) {
      // Limit to the pre-gain level that maps onto the output ceiling.
      await softLimit(pcm, ceilingLinear / gain);
      const lufsAfterLimit = measureLufs(pcm);
      gain = dbToGain(Math.max(-24, Math.min(24, targetLufs - lufsAfterLimit)));
      const peakAfterLimit = measureTruePeak(pcm);
      // Final peak guard: never let the gain push past the ceiling.
      if (peakAfterLimit > 0 && peakAfterLimit * gain > ceilingLinear) {
        gain = ceilingLinear / peakAfterLimit;
      }
    }

    await applyGain(pcm, gain, onProgress, before, span);

    const achieved = measureLufs(pcm);
    if (Math.abs(achieved - targetLufs) < 0.15) break;
    // Also stop if we are pinned at the ceiling (peak-bound material).
    if (measureTruePeak(pcm) >= ceilingLinear * 0.999 && achieved >= targetLufs - 0.3) break;
  }

  clampToCeiling(pcm, ceilingLinear);
}

/** Core: take summed stereo PCM and master it. Mutates and returns `pcm`. */
export async function masterStereoPcm(pcm: PcmData, options: MasterOptions): Promise<PcmData> {
  const stereo = toStereo(pcm);
  const profile = resolveProfile(options.genre);
  const targetLufs = resolveTargetLufs(options.loudness);
  const onProgress = options.onProgress;

  if (stereo.channels[0].length === 0) {
    throw new Error("Cannot master: audio is empty");
  }

  onProgress?.(0.02);

  // Stage 1: tone shaping + bus dynamics (2% -> 60%)
  await applyToneAndDynamics(stereo, profile, options.intensity, options.vocalFocus, onProgress, 0.02, 0.58);

  onProgress?.(0.6);

  // Stage 2: loudness normalization + true-peak ceiling (60% -> 100%)
  await normalizeLoudness(stereo, targetLufs, onProgress, 0.6, 0.4);

  onProgress?.(1);
  return stereo;
}

/* ------------------------------------------------------------------ *
 * Public entry points used by the UI
 * ------------------------------------------------------------------ */

/**
 * Master a set of WAV-encoded tracks.
 * Signature kept compatible with the UI's expectations.
 */
export async function processTracks(
  audioTracks: AudioTrackInput[],
  genre: string,
  loudness: string,
  intensity: number,
  vocalFocus: boolean,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  if (!audioTracks || audioTracks.length === 0) {
    throw new Error("No audio tracks supplied — nothing to master.");
  }

  const tracks: PcmData[] = [];
  for (let i = 0; i < audioTracks.length; i++) {
    const t = audioTracks[i];
    try {
      tracks.push(parseWav(t.data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not decode "${t.fileName}": ${message}`);
    }
    onProgress?.((0.05 * (i + 1)) / audioTracks.length);
  }

  const summed = sumTracks(tracks);
  const mastered = await masterStereoPcm(summed, {
    genre,
    loudness,
    intensity,
    vocalFocus,
    onProgress: (f) => onProgress?.(0.1 + 0.9 * f),
  });

  return new Blob([encodeWav(mastered, 24)], { type: "audio/wav" });
}

/**
 * Master already-decoded AudioBuffers (the path the main app uses).
 * Buffers are mixed straight from their sample data — no re-encoding round trip.
 */
export async function processAudioBuffers(
  tracks: DecodedTrackInput[],
  options: { genre: string; loudness: string; intensity: number; vocalFocus: boolean },
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  if (!tracks || tracks.length === 0) {
    throw new Error("No audio loaded — nothing to master.");
  }

  const pcmTracks: PcmData[] = tracks.map((t) => {
    if (!t.buffer || t.buffer.length === 0) {
      throw new Error(`Track "${t.fileName}" is empty — cannot master it.`);
    }
    const channels: Float32Array[] = [];
    for (let c = 0; c < t.buffer.numberOfChannels; c++) {
      channels.push(new Float32Array(t.buffer.getChannelData(c)));
    }
    return { sampleRate: t.buffer.sampleRate, channels };
  });

  onProgress?.(0.05);
  const summed = sumTracks(pcmTracks);
  onProgress?.(0.1);

  const mastered = await masterStereoPcm(summed, {
    ...options,
    onProgress: (f) => onProgress?.(0.1 + 0.9 * f),
  });

  return new Blob([encodeWav(mastered, 24)], { type: "audio/wav" });
}
