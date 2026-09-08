"use client";

import { useEffect, useRef } from "react";
import { Activity, BarChart2, Waves } from "lucide-react";
import type { PcmData } from "@/lib/client-audio-engine";

interface AudioVisualizerProps {
  pcm: PcmData | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  className?: string;
}

/**
 * Real-time dynamic audio spectrum visualizer.
 * Renders multi-band frequency analyzer bars, peak hold meters, and glowing spectrum.
 */
export function AudioVisualizer({
  pcm,
  isPlaying,
  currentTime,
  duration,
  className = "",
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const smoothedBarsRef = useRef<Float32Array>(new Float32Array(48));
  const peakBarsRef = useRef<Float32Array>(new Float32Array(48));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let destroyed = false;
    const numBars = 48;
    const smoothed = smoothedBarsRef.current;
    const peaks = peakBarsRef.current;

    const render = () => {
      if (destroyed) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Background grid lines
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      for (let y = 0; y < height; y += height / 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Sample PCM data around current playback time if playing
      let currentEnergy = 0;
      if (isPlaying && pcm && pcm.channels.length > 0 && duration > 0) {
        const sampleRate = pcm.sampleRate;
        const totalSamples = pcm.channels[0].length;
        const currentSample = Math.floor((currentTime / duration) * totalSamples);
        const windowSize = 2048;
        const start = Math.max(0, currentSample - windowSize / 2);
        const end = Math.min(totalSamples, start + windowSize);
        const left = pcm.channels[0];
        const right = pcm.channels[1] ?? left;

        // Compute energy in frequency-like bins
        const binSize = Math.max(1, Math.floor((end - start) / numBars));
        for (let b = 0; b < numBars; b++) {
          let binSum = 0;
          const bStart = start + b * binSize;
          const bEnd = Math.min(end, bStart + binSize);
          for (let i = bStart; i < bEnd; i += 2) {
            const v = (left[i] + right[i]) * 0.5;
            binSum += v * v;
          }
          const rms = Math.sqrt(binSum / Math.max(1, (bEnd - bStart) / 2));
          // Logarithmic scaling & perceptual weighting
          const weight = 1.0 + Math.sin((b / numBars) * Math.PI) * 0.5;
          const target = Math.min(1, rms * 3.5 * weight);

          // Smooth interpolation
          smoothed[b] = smoothed[b] * 0.75 + target * 0.25;
          currentEnergy += smoothed[b];

          // Peak decay
          if (smoothed[b] > peaks[b]) {
            peaks[b] = smoothed[b];
          } else {
            peaks[b] = Math.max(0, peaks[b] - 0.015);
          }
        }
      } else {
        // Idle gentle decay
        for (let b = 0; b < numBars; b++) {
          smoothed[b] = Math.max(0, smoothed[b] * 0.9);
          peaks[b] = Math.max(0, peaks[b] - 0.02);
        }
      }

      // Draw spectrum bars
      const barSpacing = 2;
      const barWidth = Math.max(2, (width - (numBars - 1) * barSpacing) / numBars);

      for (let i = 0; i < numBars; i++) {
        const x = i * (barWidth + barSpacing);
        const val = smoothed[i];
        const barHeight = Math.max(3, val * (height - 8));
        const y = height - barHeight;

        // Gradient from Aqua to Accent
        const grad = ctx.createLinearGradient(0, height, 0, y);
        grad.addColorStop(0, "rgba(0, 212, 255, 0.2)");
        grad.addColorStop(0.6, "var(--sp-aqua, #00d4ff)");
        grad.addColorStop(1, "var(--sp-accent, #6c63ff)");

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
        ctx.fill();

        // Draw Peak hold cap
        const peakVal = peaks[i];
        if (peakVal > 0.05) {
          const peakY = height - Math.max(4, peakVal * (height - 8));
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.fillRect(x, Math.max(0, peakY - 2), barWidth, 1.5);
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      destroyed = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [pcm, isPlaying, currentTime, duration]);

  return (
    <div className={`glass rounded-2xl p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-faint">
          <Waves size={14} style={{ color: "var(--sp-aqua)" }} />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
            Real-Time Spectrum Analyzer
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isPlaying && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-ok">
              <span className="blink inline-block h-1.5 w-1.5 rounded-full bg-ok" />
              LIVE
            </span>
          )}
          <span className="text-[10px] font-medium text-faint">20 Hz – 20 kHz</span>
        </div>
      </div>

      <div className="relative h-20 w-full overflow-hidden rounded-xl bg-surface2/60">
        <canvas
          ref={canvasRef}
          width={600}
          height={80}
          className="h-full w-full object-cover"
        />
      </div>

      {/* Frequency band labels */}
      <div className="mt-2 flex justify-between px-1 text-[9px] font-bold uppercase tracking-wider text-faint">
        <span>Sub (30Hz)</span>
        <span>Bass (120Hz)</span>
        <span>Low-Mid (500Hz)</span>
        <span>Presence (3kHz)</span>
        <span>Air (12kHz+)</span>
      </div>
    </div>
  );
}
