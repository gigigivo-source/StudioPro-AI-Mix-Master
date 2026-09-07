/**
 * Generates valid playable audio buffers (WAV PCM 16-bit / 44.1kHz)
 * for seamless A/B in-browser auditioning of before (raw mix) and after (mastered broadcast mix).
 */

export function generateSynthesizedAudioWav(
  type: "original" | "master" | "stem",
  genre: string = "HIP_HOP",
  bpm: number = 130,
  seconds: number = 12
): Buffer {
  const sampleRate = 44100;
  const numChannels = 2;
  const totalSamples = Math.floor(sampleRate * seconds);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = totalSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF Header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // 16-bit
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Musical synthesis parameters
  const beatInterval = 60 / bpm;
  const rootFreq = genre === "HIP_HOP" ? 55 : genre === "EDM" ? 65 : 73.4; // A1 or C2 or D2
  const isMaster = type === "master";

  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const beatPos = (t % beatInterval) / beatInterval;
    const barPos = (t % (beatInterval * 4)) / (beatInterval * 4);

    // 1. Kick Drum (exponential pitch drop on beat 0 and 2)
    let kick = 0;
    if (beatPos < 0.25) {
      const kickEnv = Math.exp(-beatPos * 18);
      const kickFreq = 120 * Math.exp(-beatPos * 25) + 45;
      kick = Math.sin(2 * Math.PI * kickFreq * beatPos) * kickEnv;
    }

    // 2. Snare / Clap on beats 1 and 3
    let snare = 0;
    const halfBar = (t % (beatInterval * 2)) / (beatInterval * 2);
    if (halfBar > 0.5 && halfBar < 0.8) {
      const sT = halfBar - 0.5;
      const noise = (Math.random() * 2 - 1) * Math.exp(-sT * 14);
      const tone = Math.sin(2 * Math.PI * 220 * sT) * Math.exp(-sT * 20);
      snare = (noise * 0.7 + tone * 0.3) * 0.8;
    }

    // 3. Bass line
    const bassNote = barPos < 0.5 ? rootFreq : rootFreq * 1.334; // Root to 4th
    let bass = Math.sin(2 * Math.PI * bassNote * t);
    // Add 2nd harmonic
    bass += 0.4 * Math.sin(2 * Math.PI * bassNote * 2 * t);
    bass *= 0.45;

    // 4. Synth / Chord pad
    const chord1 = Math.sin(2 * Math.PI * (rootFreq * 4) * t);
    const chord2 = Math.sin(2 * Math.PI * (rootFreq * 4.8) * t);
    const chord3 = Math.sin(2 * Math.PI * (rootFreq * 6) * t);
    const pad = (chord1 + chord2 + chord3) * 0.12;

    // Sum
    let rawLeft = kick * 0.7 + snare * 0.5 + bass * 0.6 + pad * 0.7;
    let rawRight = kick * 0.7 + snare * 0.5 + bass * 0.6 + pad * 0.8;

    // Post-production processing differential:
    if (isMaster) {
      // MASTER: High punch, wide stereo, analog warmth, balanced frequency, limited peak
      // Soft saturation
      rawLeft = Math.tanh(rawLeft * 1.55);
      rawRight = Math.tanh(rawRight * 1.55);

      // Stereo widening on highs
      const mid = (rawLeft + rawRight) * 0.5;
      const side = (rawLeft - rawRight) * 0.5;
      rawLeft = mid + side * 1.45;
      rawRight = mid - side * 1.45;

      // Make louder, compressed, commercial punch
      rawLeft *= 0.88;
      rawRight *= 0.88;
    } else {
      // ORIGINAL: Pre-mix raw, dynamic peaks, slightly duller, narrower stereo
      rawLeft *= 0.45;
      rawRight *= 0.45;
    }

    // Clamp to 16-bit range
    const intLeft = Math.max(-32768, Math.min(32767, Math.floor(rawLeft * 32767)));
    const intRight = Math.max(-32768, Math.min(32767, Math.floor(rawRight * 32767)));

    buffer.writeInt16LE(intLeft, offset);
    buffer.writeInt16LE(intRight, offset + 2);
    offset += 4;
  }

  return buffer;
}
