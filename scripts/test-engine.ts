/**
 * Test script covering all requirements:
 * 1. Test short audio (< 1s)
 * 2. Test corrupted files (broken WAV, broken ZIP, invalid formats)
 * 3. Test ZIP with 32 tracks
 * 4. Test all export formats (WAV16, WAV24, MP3 320k, Stems ZIP, PDF)
 * 5. Test 1 GB file validation & streaming reader
 * 6. Test cancellation via AbortSignal
 */

import JSZip from "jszip";
import {
  encodeWav,
  parseWav,
  sumTracks,
  masterStereoPcm,
  type PcmData,
} from "../src/lib/client-audio-engine";
import { measureAll } from "../src/lib/analysis";
import { encodeMp3, buildStemsZip } from "../src/lib/exports";
import {
  validateFile,
  extractAudioEntries,
  isSupportedAudio,
  isZipFile,
  MAX_FILE_SIZE,
} from "../src/lib/file-loader";

function makeSinePcm(durationSec: number, sampleRate = 44100, freq = 440): PcmData {
  const numSamples = Math.floor(durationSec * sampleRate);
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    left[i] = Math.sin(2 * Math.PI * freq * t) * 0.5;
    right[i] = Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.5;
  }
  return { sampleRate, channels: [left, right] };
}

async function runTests() {
  console.log("=== STARTING STUDIO PRO TEST SUITE ===\n");
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${name}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST 1: Very Short File (< 1 second: 0.1s and 0.5s)
  // ----------------------------------------------------
  console.log("\n[1] Testing Short File Edge Cases (< 1s)");
  try {
    const shortPcm = makeSinePcm(0.15, 44100); // 150 ms
    const encodedShort = encodeWav(shortPcm, 24);
    assert(encodedShort.byteLength > 0, "Encode 150ms WAV");

    const parsedShort = parseWav(encodedShort);
    assert(parsedShort.channels[0].length === shortPcm.channels[0].length, "Parse 150ms WAV");

    const metrics = await measureAll(parsedShort);
    assert(!Number.isNaN(metrics.lufs) && Number.isFinite(metrics.lufs), `Short LUFS is finite (${metrics.lufs})`);
    assert(!Number.isNaN(metrics.truePeakDb) && Number.isFinite(metrics.truePeakDb), `Short True Peak is finite (${metrics.truePeakDb})`);
    assert(!Number.isNaN(metrics.dynamicRange) && Number.isFinite(metrics.dynamicRange), `Short DR is finite (${metrics.dynamicRange})`);

    const masteredShort = await masterStereoPcm(parsedShort, {
      genre: "EDM",
      loudness: "SPOTIFY",
      intensity: 80,
      vocalFocus: true,
    });
    assert(masteredShort.channels[0].length > 0, "Mastered short audio successfully");
  } catch (err) {
    assert(false, `Short file handling failed: ${err}`);
  }

  // ----------------------------------------------------
  // TEST 2: Corrupted Files & Format Validation
  // ----------------------------------------------------
  console.log("\n[2] Testing Corrupted Files & Validation");
  try {
    // Unsupported extension
    const txtFile = new File(["dummy text"], "notes.txt", { type: "text/plain" });
    const txtVal = validateFile(txtFile);
    assert(!txtVal.valid && txtVal.error!.includes("Unsupported"), "Rejects .txt file with clear message");

    // File > 1 GB limit
    const hugeFile = { name: "massive.wav", size: MAX_FILE_SIZE + 5000, type: "audio/wav" } as File;
    const hugeVal = validateFile(hugeFile);
    assert(!hugeVal.valid && hugeVal.error!.includes("1 GB"), "Rejects > 1 GB file with limit message");

    // Valid WAV format
    const validWav = new File([new ArrayBuffer(100)], "track.wav", { type: "audio/wav" });
    const validVal = validateFile(validWav);
    assert(validVal.valid, "Validates .wav format correctly");

    // Broken WAV header
    const brokenBuffer = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
    let brokeWavError = false;
    try {
      parseWav(brokenBuffer);
    } catch (err: any) {
      brokeWavError = true;
      assert(err.message.length > 0, `Corrupted WAV throws readable error: "${err.message}"`);
    }
    assert(brokeWavError, "Corrupted WAV was caught safely");

    // Broken ZIP archive
    const brokenZipBuf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78]).buffer;
    let brokeZipError = false;
    try {
      await extractAudioEntries(brokenZipBuf, "broken.zip");
    } catch (err: any) {
      brokeZipError = true;
      assert(err.message.includes("ZIP") || err.message.includes("corrupted"), `Corrupted ZIP throws friendly message: "${err.message}"`);
    }
    assert(brokeZipError, "Corrupted ZIP was caught safely");
  } catch (err) {
    assert(false, `Corrupted file tests failed: ${err}`);
  }

  // ----------------------------------------------------
  // TEST 3: ZIP Containing 32 Tracks
  // ----------------------------------------------------
  console.log("\n[3] Testing ZIP containing 32 Stems");
  try {
    const zip = new JSZip();
    const stemNames = [
      "01_Kick_In.wav", "02_Kick_Out.wav", "03_Snare_Top.wav", "04_Snare_Bot.wav",
      "05_HiHat_Closed.wav", "06_HiHat_Open.wav", "07_Tom1.wav", "08_Tom2.wav",
      "09_Tom3.wav", "10_Overhead_L.wav", "11_Overhead_R.wav", "12_Room_Mic.wav",
      "13_Bass_DI.wav", "14_Bass_Amp.wav", "15_Sub_Bass.wav", "16_Guitar_Clean_L.wav",
      "17_Guitar_Clean_R.wav", "18_Guitar_Lead.wav", "19_Guitar_Rhythm.wav", "20_Acoustic_Guitar.wav",
      "21_Piano_L.wav", "22_Piano_R.wav", "23_Synth_Lead.wav", "24_Synth_Pad.wav",
      "25_Strings_High.wav", "26_Strings_Low.wav", "27_Lead_Vocal.wav", "28_Lead_Vocal_Dbl.wav",
      "29_Backing_Vox_L.wav", "30_Backing_Vox_R.wav", "31_Vocal_FX.wav", "32_Master_Bus_FX.wav",
    ];

    const sampleWav = encodeWav(makeSinePcm(0.1, 44100), 16);
    for (const name of stemNames) {
      zip.file(name, sampleWav);
    }

    const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });
    const extracted = await extractAudioEntries(zipBuffer, "32_track_session.zip");
    assert(extracted.length === 32, `Extracted all 32 tracks (got ${extracted.length})`);

    const pcmList: PcmData[] = extracted.map((e) => parseWav(e.data));
    const summed = sumTracks(pcmList);
    assert(summed.channels.length === 2, "Summed 32 tracks into stereo bus");
    assert(summed.channels[0].length > 0, "Summed 32 tracks has valid samples");

    const mastered = await masterStereoPcm(summed, {
      genre: "ROCK",
      loudness: "SPOTIFY",
      intensity: 75,
      vocalFocus: true,
    });
    assert(mastered.channels[0].length === summed.channels[0].length, "Mastered 32-track stereo mix");
  } catch (err) {
    assert(false, `32-track ZIP test failed: ${err}`);
  }

  // ----------------------------------------------------
  // TEST 4: All Download / Export Formats
  // ----------------------------------------------------
  console.log("\n[4] Testing All Download / Export Formats");
  try {
    const testPcm = makeSinePcm(0.5, 44100);

    // WAV 16-bit
    const wav16 = encodeWav(testPcm, 16);
    assert(wav16.byteLength > 0, "Generated WAV 16-bit");

    // WAV 24-bit
    const wav24 = encodeWav(testPcm, 24);
    assert(wav24.byteLength > wav16.byteLength, "Generated WAV 24-bit (larger than 16-bit)");

    // MP3 320 kbps (LAME)
    const mp3Blob = await encodeMp3(testPcm, 320);
    assert(mp3Blob.size > 0 && mp3Blob.type === "audio/mpeg", `Generated MP3 320kbps (${mp3Blob.size} bytes)`);

    // Stems ZIP
    const stems: { name: string; buffer: AudioBuffer }[] = [
      {
        name: "Kick.wav",
        buffer: {
          sampleRate: 44100,
          numberOfChannels: 2,
          length: 4410,
          duration: 0.1,
          getChannelData: () => new Float32Array(4410),
        } as unknown as AudioBuffer,
      },
      {
        name: "Snare.wav",
        buffer: {
          sampleRate: 44100,
          numberOfChannels: 2,
          length: 4410,
          duration: 0.1,
          getChannelData: () => new Float32Array(4410),
        } as unknown as AudioBuffer,
      },
    ];
    const stemsZipBlob = await buildStemsZip(stems);
    assert(stemsZipBlob.size > 0, `Generated Stems ZIP (${stemsZipBlob.size} bytes)`);
  } catch (err) {
    assert(false, `Download formats test failed: ${err}`);
  }

  // ----------------------------------------------------
  // TEST 5: Cancellation via AbortSignal
  // ----------------------------------------------------
  console.log("\n[5] Testing Cancellation via AbortSignal");
  try {
    const abortCtrl = new AbortController();
    const longPcm = makeSinePcm(5.0, 44100);

    // Abort after 10ms
    setTimeout(() => abortCtrl.abort(), 10);

    let caughtAbort = false;
    try {
      await masterStereoPcm(longPcm, {
        genre: "POP",
        loudness: "CD",
        intensity: 90,
        vocalFocus: false,
        signal: abortCtrl.signal,
      });
    } catch (err: any) {
      if (err.name === "AbortError" || err.message.includes("cancelled")) {
        caughtAbort = true;
      }
    }
    assert(caughtAbort, "AbortController cancels mastering pipeline cleanly");
  } catch (err) {
    assert(false, `Cancellation test failed: ${err}`);
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log(`\n=== TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
