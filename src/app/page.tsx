"use client";

import { useState, useRef, useCallback } from "react";
import JSZip from "jszip";
import * as clientEngine from "@/lib/client-audio-engine";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".aiff", ".aif", ".opus", ".webm"];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
};

const GENRES = ["POP", "HIP_HOP", "EDM", "ROCK", "ACOUSTIC", "CLASSICAL", "JAZZ", "METAL", "R_AND_B", "LO_FI"];
const LOUDNESS_TARGETS = ["SPOTIFY", "APPLE_MUSIC", "YOUTUBE", "CD"];

interface LoadedTrack {
  name: string;
  buffer: AudioBuffer;
}

export default function Home() {
  const [status, setStatus] = useState("Upload your FL Studio Mobile ZIP");
  const [trackNames, setTrackNames] = useState<string[]>([]);
  const [rawAudioUrls, setRawAudioUrls] = useState<string[]>([]);
  const [audioBuffers, setAudioBuffers] = useState<AudioBuffer[]>([]);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [processedInfo, setProcessedInfo] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [selectedGenre, setSelectedGenre] = useState("POP");
  const [selectedLoudness, setSelectedLoudness] = useState("SPOTIFY");
  const [intensity, setIntensity] = useState(75);
  const [vocalFocus, setVocalFocus] = useState(true);
  const [showResults, setShowResults] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const processedRef = useRef<HTMLAudioElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  /** Reuse a single AudioContext — browsers cap how many can exist. */
  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const Ctor: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  }, []);

  const resetOutputs = useCallback(() => {
    setProcessedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRawAudioUrls((prev) => {
      prev.forEach((u) => URL.revokeObjectURL(u));
      return [];
    });
    setProcessedInfo(null);
    setShowResults(false);
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    resetOutputs();
    setStatus("📦 Loading ZIP...");

    try {
      const zip = await JSZip.loadAsync(file);
      const audioFiles: { name: string; data: ArrayBuffer }[] = [];

      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        // Skip OS junk that otherwise shows up as unreadable "tracks".
        if (path.includes("__MACOSX") || path.includes(".DS_Store") || path.startsWith(".")) continue;

        const dot = path.lastIndexOf(".");
        const ext = dot === -1 ? "" : path.toLowerCase().slice(dot);
        if (AUDIO_EXTENSIONS.includes(ext)) {
          const data = await entry.async("arraybuffer");
          const name = path.split("/").pop() || path;
          audioFiles.push({ name, data });
        }
      }

      if (audioFiles.length === 0) {
        setStatus("❌ No audio files found in ZIP");
        return;
      }

      setTrackNames(audioFiles.map((f) => f.name));

      // Blob URLs for immediate raw playback (proven path).
      // Blob construction copies the bytes, so decoding below cannot detach them.
      const urls = audioFiles.map((f) => {
        const dot = f.name.lastIndexOf(".");
        const ext = dot === -1 ? "" : f.name.toLowerCase().slice(dot);
        const mime = MIME_BY_EXTENSION[ext] || "audio/wav";
        return URL.createObjectURL(new Blob([f.data], { type: mime }));
      });
      setRawAudioUrls(urls);

      // Decode to AudioBuffers for processing.
      const ctx = getAudioContext();
      const decoded: AudioBuffer[] = [];
      for (const f of audioFiles) {
        setStatus(`🔊 Decoding ${f.name}...`);
        const buffer = await ctx.decodeAudioData(f.data.slice(0));
        decoded.push(buffer);
      }
      setAudioBuffers(decoded);

      const totalSeconds = Math.max(...decoded.map((b) => b.duration));
      const mm = Math.floor(totalSeconds / 60);
      const ss = Math.floor(totalSeconds % 60)
        .toString()
        .padStart(2, "0");
      setStatus(`✅ ${decoded.length} tracks loaded (${mm}:${ss}). Ready to mix & master.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`❌ Could not read ZIP: ${message}`);
    }
  };

  const handleProcess = async () => {
    if (audioBuffers.length === 0) {
      alert("No audio loaded. Please upload a ZIP first.");
      return;
    }

    setProcessing(true);
    setProgress(0);
    setStatus("🎛️ Processing your audio...");

    const startedAt = performance.now();

    try {
      const tracks = audioBuffers.map((buffer, i) => ({
        fileName: trackNames[i] || `track${i}`,
        buffer,
        isUserUploaded: true,
      }));

      const processedBlob = await clientEngine.processAudioBuffers(
        tracks,
        {
          genre: selectedGenre,
          loudness: selectedLoudness,
          intensity,
          vocalFocus,
        },
        (fraction) => setProgress(Math.round(fraction * 100))
      );

      const url = URL.createObjectURL(processedBlob);
      setProcessedUrl(url);
      setProgress(100);

      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      setProcessedInfo(
        `${tracks.length} track(s) summed · ${selectedGenre} · ${selectedLoudness} · ` +
          `${(processedBlob.size / 1024 / 1024).toFixed(2)} MB WAV · ${elapsed}s`
      );
      setStatus("✅ Processing complete!");
      setShowResults(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      setStatus(`❌ Processing failed: ${message}`);
    } finally {
      setProcessing(false);
    }
  };

  const playRaw = (index: number) => {
    if (audioRef.current && rawAudioUrls[index]) {
      audioRef.current.src = rawAudioUrls[index];
      void audioRef.current.play();
    }
  };

  const downloadProcessed = () => {
    if (processedUrl) {
      const a = document.createElement("a");
      a.href = processedUrl;
      a.download = "mastered.wav";
      a.click();
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "800px", margin: "0 auto", fontFamily: "sans-serif" }}>
      <h1>🎵 StudioPro – Mix &amp; Master</h1>
      <p>Upload your FL Studio Mobile ZIP to get a professional master.</p>

      <input
        type="file"
        accept=".zip"
        onChange={handleFileUpload}
        style={{ display: "block", margin: "20px 0", padding: "10px" }}
      />

      <div style={{ padding: "15px", background: "#f0f0f0", borderRadius: "8px", marginBottom: "20px" }}>
        <strong>Status:</strong> {status}
      </div>

      {rawAudioUrls.length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          <h3>📂 Tracks</h3>
          <ul>
            {trackNames.map((name, i) => (
              <li key={i}>
                {name}
                <button onClick={() => playRaw(i)} style={{ marginLeft: "10px" }}>
                  ▶️ Preview
                </button>
              </li>
            ))}
          </ul>
          <audio ref={audioRef} controls style={{ width: "100%", marginTop: "10px" }} />
        </div>
      )}

      {rawAudioUrls.length > 0 && !showResults && (
        <div style={{ border: "1px solid #ccc", padding: "20px", borderRadius: "8px" }}>
          <h3>🎛️ Settings</h3>
          <div>
            <label>Genre: </label>
            <select value={selectedGenre} onChange={(e) => setSelectedGenre(e.target.value)}>
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Loudness: </label>
            <select value={selectedLoudness} onChange={(e) => setSelectedLoudness(e.target.value)}>
              {LOUDNESS_TARGETS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Intensity: {intensity}%</label>
            <input
              type="range"
              min="0"
              max="100"
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
            />
          </div>
          <div>
            <label>
              <input type="checkbox" checked={vocalFocus} onChange={(e) => setVocalFocus(e.target.checked)} />
              Vocal Focus
            </label>
          </div>
          <button onClick={handleProcess} disabled={processing} style={{ padding: "10px 20px", marginTop: "10px" }}>
            {processing ? "Processing..." : "🚀 Mix &amp; Master"}
          </button>
          {processing && <div>Progress: {progress}%</div>}
        </div>
      )}

      {showResults && processedUrl && (
        <div style={{ marginTop: "30px", border: "2px solid green", padding: "20px", borderRadius: "8px" }}>
          <h3>✅ Mastered</h3>
          {processedInfo && <p style={{ margin: "0 0 10px", color: "#555" }}>{processedInfo}</p>}
          <audio ref={processedRef} src={processedUrl} controls style={{ width: "100%" }} />
          <div>
            <button onClick={downloadProcessed} style={{ marginTop: "10px", padding: "10px 20px" }}>
              ⬇️ Download WAV
            </button>
            <button
              onClick={() => {
                setShowResults(false);
                setStatus("Ready to re-master with different settings.");
              }}
              style={{ marginTop: "10px", marginLeft: "10px", padding: "10px 20px" }}
            >
              ⚙️ Change settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
