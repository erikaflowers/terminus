// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Audio Visualizer panel — real-time frequency visualization with Now Playing metadata

import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { getApi, WOS } from "@/store/global";
import * as jotai from "jotai";
import * as React from "react";

import {
    applyGlow,
    BG_DARK,
    clearGlow,
    GRID_BRIGHT,
    GRID_DIM,
    PHOSPHOR_AMBER,
    PHOSPHOR_GREEN,
    PHOSPHOR_GREEN_DIM,
    TEXT_DIM,
} from "../vizutil/vizcolors";
import { clamp, DrawFunction, lerp, useAnimationLoop, useCanvasSetup } from "../vizutil/vizutil";

// --- Types ---

type VizMode = "spectrum" | "waveform" | "circular" | "basscannon";

interface NowPlaying {
    track: string;
    artist: string;
    album: string;
    artworkDataUrl: string | null;
}

// --- Audio State ---

class AudioState {
    analyser: AnalyserNode | null = null;
    audioCtx: AudioContext | null = null;
    stream: MediaStream | null = null;
    freqData: Uint8Array = new Uint8Array(0);
    timeData: Uint8Array = new Uint8Array(0);
    smoothedFreq: Float32Array = new Float32Array(0);
    peakFreq: Float32Array = new Float32Array(0);
    mode: VizMode = "spectrum";
    nowPlaying: NowPlaying | null = null;
    lastTrack: string = "";
    connected: boolean = false;
    connecting: boolean = false;
    errorMsg: string = "";
    idlePhase: number = 0;
    freqLow: number = 30;
    freqHigh: number = 16000;
    sampleRate: number = 44100;
    splitMode: boolean = false;
    crossover: number = 250;
    bassEnergy: number = 0;
    bassHitDecay: number = 0;
    // Colors (hex)
    colorLowDim: string = "#1a5c00";
    colorLowBright: string = "#00ff41";
    colorHighDim: string = "#005566";
    colorHighBright: string = "#00ccff";
    // Attack/Release (0.05 = slow, 1.0 = instant)
    attack: number = 0.3;
    release: number = 0.15;
    lowAttack: number = 0.8;
    lowRelease: number = 0.35;
    highAttack: number = 0.3;
    highRelease: number = 0.12;

    async connect(): Promise<boolean> {
        if (this.connecting || this.connected) return this.connected;
        this.connecting = true;
        this.errorMsg = "";
        try {
            console.log("[visualizer] requesting getDisplayMedia...");
            const stream = await navigator.mediaDevices.getDisplayMedia({
                audio: true,
                video: true,
            });

            const allTracks = stream.getTracks();
            console.log(
                "[visualizer] stream obtained, tracks:",
                allTracks.map((t) => `${t.kind}:${t.label}:${t.readyState}`)
            );

            // Keep video tracks alive for now (stopping them may kill the audio on some builds)
            const audioTracks = stream.getAudioTracks();
            console.log("[visualizer] audio tracks:", audioTracks.length);

            if (audioTracks.length === 0) {
                const msg = "Stream has no audio tracks — system audio loopback not available in this build";
                console.warn("[visualizer]", msg);
                this.errorMsg = msg;
                // Stop all tracks since we can't use them
                allTracks.forEach((t) => t.stop());
                this.connecting = false;
                return false;
            }

            this.stream = stream;
            this.audioCtx = new AudioContext();
            this.sampleRate = this.audioCtx.sampleRate;
            const audioStream = new MediaStream(audioTracks);
            const source = this.audioCtx.createMediaStreamSource(audioStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0.4;
            source.connect(this.analyser);

            const binCount = this.analyser.frequencyBinCount;
            this.freqData = new Uint8Array(binCount);
            this.timeData = new Uint8Array(binCount);
            this.smoothedFreq = new Float32Array(binCount);
            this.peakFreq = new Float32Array(binCount);
            this.connected = true;
            this.connecting = false;
            console.log("[visualizer] audio connected, bins:", binCount);

            // Now stop video tracks since audio is established
            stream.getVideoTracks().forEach((t) => t.stop());
            return true;
        } catch (e) {
            const msg = (e as Error).message || String(e);
            console.warn("[visualizer] audio capture failed:", msg);
            this.errorMsg = msg;
            this.connecting = false;
            return false;
        }
    }

    disconnect(): void {
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
        this.analyser = null;
        this.connected = false;
    }

    update(): void {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(this.freqData);
        this.analyser.getByteTimeDomainData(this.timeData);

        // Per-band attack/release smoothing
        let binCrossover = this.freqData.length;
        if (this.splitMode && this.analyser) {
            const hzPerBin = this.sampleRate / this.analyser.fftSize;
            binCrossover = Math.floor(this.crossover / hzPerBin);
        }

        for (let i = 0; i < this.freqData.length; i++) {
            const raw = this.freqData[i];
            const rising = raw > this.smoothedFreq[i];
            let atk: number, rel: number;
            if (this.splitMode) {
                const isLow = i < binCrossover;
                atk = isLow ? this.lowAttack : this.highAttack;
                rel = isLow ? this.lowRelease : this.highRelease;
            } else {
                atk = this.attack;
                rel = this.release;
            }
            this.smoothedFreq[i] = lerp(this.smoothedFreq[i], raw, rising ? atk : rel);
            // Peak hold — decay tied to release speed
            if (raw > this.peakFreq[i]) {
                this.peakFreq[i] = raw;
            } else {
                this.peakFreq[i] *= 1.0 - rel * 0.08;
            }
        }

        // Bass energy tracking (active in split mode or bass cannon mode)
        if ((this.splitMode || this.mode === "basscannon") && this.analyser) {
            const hzPerBin = this.sampleRate / this.analyser.fftSize;
            const binLow = Math.max(0, Math.floor(this.freqLow / hzPerBin));
            const binCross = Math.min(this.freqData.length - 1, Math.floor(this.crossover / hzPerBin));
            let sum = 0;
            const count = Math.max(1, binCross - binLow);
            for (let i = binLow; i < binCross && i < this.freqData.length; i++) {
                sum += this.freqData[i];
            }
            const rawBass = sum / count / 255;
            if (rawBass > this.bassEnergy) {
                this.bassEnergy = lerp(this.bassEnergy, rawBass, this.lowAttack);
            } else {
                this.bassEnergy *= 1.0 - this.lowRelease * 0.5;
            }
            if (rawBass > 0.35 && rawBass > this.bassEnergy * 0.85) {
                this.bassHitDecay = 1.0;
            }
            this.bassHitDecay *= 1.0 - this.lowRelease * 0.3;
        }
    }
}

// --- Draw Functions ---

function drawCrtOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // Vignette
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Scanlines
    ctx.fillStyle = "rgba(0, 0, 0, 0.035)";
    for (let y = 0; y < h; y += 2) {
        ctx.fillRect(0, y, w, 1);
    }

    // Occasional flicker
    if (Math.random() < 0.02) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.015})`;
        ctx.fillRect(0, 0, w, h);
    }
}

function drawNoiseFloor(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = "rgba(0, 255, 65, 0.015)";
    for (let i = 0; i < 40; i++) {
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
}

function hexToRgb(hex: string): [number, number, number] {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function bandColor(dimHex: string, brightHex: string, intensity: number, alpha: number): string {
    const [dr, dg, db] = hexToRgb(dimHex);
    const [br, bg, bb] = hexToRgb(brightHex);
    const t = clamp(intensity, 0, 1);
    return `rgba(${Math.floor(dr + (br - dr) * t)}, ${Math.floor(dg + (bg - dg) * t)}, ${Math.floor(db + (bb - db) * t)}, ${alpha})`;
}

function hexRgba(hex: string, alpha: number): string {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawSpectrum(ctx: CanvasRenderingContext2D, state: AudioState, w: number, h: number, elapsed: number): void {
    const margin = 20;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2 - 40; // leave room for metadata at bottom
    const binCount = state.smoothedFreq.length;
    if (binCount === 0) return;

    // Map frequency range to FFT bins
    const hzPerBin = state.sampleRate / (state.analyser?.fftSize ?? 2048);
    const binLow = Math.max(0, Math.floor(state.freqLow / hzPerBin));
    const binHigh = Math.min(binCount - 1, Math.floor(state.freqHigh / hzPerBin));
    const binRange = binHigh - binLow;
    if (binRange <= 0) return;

    const numBars = Math.min(120, Math.floor(plotW / 4));
    const barW = Math.max(2, plotW / numBars - 1);
    const gap = 1;

    for (let i = 0; i < numBars; i++) {
        const t = i / numBars;
        const binIdx = binLow + Math.floor(Math.pow(t, 1.5) * binRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const peak = state.peakFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barH = (val / 255) * plotH;
        const peakY = margin + plotH - (peak / 255) * plotH;

        const x = margin + i * (barW + gap);
        const y = margin + plotH - barH;

        // Bar fill
        const color = bandColor(state.colorLowDim, state.colorLowBright, val / 255, 0.6 + (val / 255) * 0.4);
        ctx.fillStyle = color;
        applyGlow(ctx, color, 4);
        ctx.fillRect(x, y, barW, barH);
        clearGlow(ctx);

        // Peak hold dot
        if (peak > 5) {
            ctx.fillStyle = state.colorLowBright;
            applyGlow(ctx, state.colorLowBright, 6);
            ctx.fillRect(x, peakY, barW, 1.5);
            clearGlow(ctx);
        }
    }

    // Baseline
    ctx.strokeStyle = GRID_DIM;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin, margin + plotH);
    ctx.lineTo(margin + plotW, margin + plotH);
    ctx.stroke();

    // Frequency labels (reflect actual range)
    ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT_DIM;
    const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}Hz`);
    ctx.fillText(fmtHz(state.freqLow), margin, margin + plotH + 12);
    ctx.textAlign = "right";
    ctx.fillText(fmtHz(state.freqHigh), margin + plotW, margin + plotH + 12);
    ctx.textAlign = "left";
}

function drawWaveformViz(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    const margin = 20;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2 - 40;
    const binCount = state.timeData.length;
    if (binCount === 0) return;

    // Grid
    ctx.strokeStyle = GRID_DIM;
    ctx.lineWidth = 0.3;
    for (let i = 0; i <= 8; i++) {
        const y = margin + (plotH / 8) * i;
        ctx.beginPath();
        ctx.moveTo(margin, y);
        ctx.lineTo(margin + plotW, y);
        ctx.stroke();
    }

    // Center line
    ctx.strokeStyle = GRID_BRIGHT;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin, margin + plotH / 2);
    ctx.lineTo(margin + plotW, margin + plotH / 2);
    ctx.stroke();

    // Ghost trace
    ctx.beginPath();
    ctx.strokeStyle = "rgba(0, 255, 65, 0.06)";
    ctx.lineWidth = 1;
    const step = Math.max(1, Math.floor(binCount / plotW));
    for (let i = 0; i < plotW; i++) {
        const idx = Math.floor((i / plotW) * binCount);
        const val = state.timeData[idx] ?? 128;
        const y = margin + (val / 255) * plotH;
        const jitter = Math.sin(elapsed / 200 + i * 0.3) * 2;
        if (i === 0) ctx.moveTo(margin + i, y + jitter);
        else ctx.lineTo(margin + i, y + jitter);
    }
    ctx.stroke();

    // Main waveform
    ctx.beginPath();
    ctx.strokeStyle = PHOSPHOR_GREEN;
    ctx.lineWidth = 1.8;
    applyGlow(ctx, PHOSPHOR_GREEN, 8);
    for (let i = 0; i < plotW; i++) {
        const idx = Math.floor((i / plotW) * binCount);
        const val = state.timeData[idx] ?? 128;
        const y = margin + (val / 255) * plotH;
        if (i === 0) ctx.moveTo(margin + i, y);
        else ctx.lineTo(margin + i, y);
    }
    ctx.stroke();
    clearGlow(ctx);

    // Labels
    ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText("WAVEFORM", margin + 4, margin + 12);
}

function drawCircularViz(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    const cx = w / 2;
    const cy = h / 2 - 15; // shift up for metadata
    const maxR = Math.min(w, h) * 0.38;
    const innerR = maxR * 0.3;
    const binCount = state.smoothedFreq.length;
    if (binCount === 0) return;

    const hzPerBin = state.sampleRate / (state.analyser?.fftSize ?? 2048);
    const binLow = Math.max(0, Math.floor(state.freqLow / hzPerBin));
    const binHigh = Math.min(binCount - 1, Math.floor(state.freqHigh / hzPerBin));
    const binRange = Math.max(1, binHigh - binLow);

    const numSegments = 90;
    const angleStep = (Math.PI * 2) / numSegments;

    // Inner ring glow
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.strokeStyle = PHOSPHOR_GREEN_DIM;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Frequency segments
    for (let i = 0; i < numSegments; i++) {
        const t = i / numSegments;
        const binIdx = binLow + Math.floor(Math.pow(t, 1.5) * binRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barLen = (val / 255) * (maxR - innerR);

        const angle = angleStep * i - Math.PI / 2;
        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * (innerR + barLen);
        const y2 = cy + Math.sin(angle) * (innerR + barLen);

        const color = bandColor(state.colorLowDim, state.colorLowBright, val / 255, 0.6 + (val / 255) * 0.4);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * innerR) / numSegments - 1);
        applyGlow(ctx, color, 3);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        clearGlow(ctx);
    }

    // Center circle
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 10, 10, 0.8)";
    ctx.fill();

    // Rotating indicator
    const rotAngle = elapsed / 2000;
    ctx.strokeStyle = PHOSPHOR_GREEN;
    ctx.lineWidth = 1;
    applyGlow(ctx, PHOSPHOR_GREEN, 4);
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 6, rotAngle, rotAngle + 0.5);
    ctx.stroke();
    clearGlow(ctx);
}

function drawSpectrumSplit(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    const margin = 20;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2 - 40;
    const binCount = state.smoothedFreq.length;
    if (binCount === 0) return;

    const hzPerBin = state.sampleRate / (state.analyser?.fftSize ?? 2048);
    const binLow = Math.max(0, Math.floor(state.freqLow / hzPerBin));
    const binHigh = Math.min(binCount - 1, Math.floor(state.freqHigh / hzPerBin));
    const binCross = clamp(Math.floor(state.crossover / hzPerBin), binLow + 1, binHigh - 1);
    const lowRange = Math.max(1, binCross - binLow);
    const highRange = Math.max(1, binHigh - binCross);

    // --- Low band layer (warm, wide bars, heavy glow) ---
    const numLowBars = Math.min(50, Math.floor(plotW / 6));
    const lowBarW = Math.max(3, plotW / numLowBars - 2);

    for (let i = 0; i < numLowBars; i++) {
        const t = i / numLowBars;
        const binIdx = binLow + Math.floor(Math.pow(t, 1.3) * lowRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barH = (val / 255) * plotH * 1.1;

        const x = margin + (i / numLowBars) * plotW;
        const y = margin + plotH - barH;

        const alpha = 0.35 + (val / 255) * 0.45;
        const color = bandColor(state.colorLowDim, state.colorLowBright, val / 255, alpha);

        ctx.fillStyle = color;
        applyGlow(ctx, color, 8);
        ctx.fillRect(x, y, lowBarW, barH);
        clearGlow(ctx);
    }

    // --- High band layer (cool, thin bars, sharp) ---
    const numHighBars = Math.min(90, Math.floor(plotW / 4));
    const highBarW = Math.max(2, plotW / numHighBars - 1);

    for (let i = 0; i < numHighBars; i++) {
        const t = i / numHighBars;
        const binIdx = binCross + Math.floor(Math.pow(t, 1.4) * highRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const peak = state.peakFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barH = (val / 255) * plotH;
        const peakY = margin + plotH - (peak / 255) * plotH;

        const x = margin + (i / numHighBars) * plotW;
        const y = margin + plotH - barH;

        const alpha = 0.45 + (val / 255) * 0.55;
        const color = bandColor(state.colorHighDim, state.colorHighBright, val / 255, alpha);

        ctx.fillStyle = color;
        applyGlow(ctx, color, 3);
        ctx.fillRect(x, y, highBarW, barH);
        clearGlow(ctx);

        if (peak > 5) {
            ctx.fillStyle = state.colorHighBright;
            ctx.fillRect(x, peakY, highBarW, 1.5);
        }
    }

    // Baseline
    ctx.strokeStyle = GRID_DIM;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin, margin + plotH);
    ctx.lineTo(margin + plotW, margin + plotH);
    ctx.stroke();

    // Labels
    ctx.font = "8px 'JetBrains Mono', monospace";
    const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}Hz`);
    ctx.fillStyle = "rgba(255, 140, 0, 0.5)";
    ctx.fillText("LOW", margin, margin + plotH + 12);
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = "center";
    ctx.fillText(fmtHz(state.crossover), margin + plotW / 2, margin + plotH + 12);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(0, 200, 220, 0.5)";
    ctx.fillText("HIGH", margin + plotW, margin + plotH + 12);
    ctx.textAlign = "left";
}

function drawCircularSplit(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    const cx = w / 2;
    const cy = h / 2 - 15;
    const maxR = Math.min(w, h) * 0.38;
    const innerR = maxR * 0.3;
    const midR = innerR + (maxR - innerR) * 0.45;
    const binCount = state.smoothedFreq.length;
    if (binCount === 0) return;

    const hzPerBin = state.sampleRate / (state.analyser?.fftSize ?? 2048);
    const binLow = Math.max(0, Math.floor(state.freqLow / hzPerBin));
    const binHigh = Math.min(binCount - 1, Math.floor(state.freqHigh / hzPerBin));
    const binCross = clamp(Math.floor(state.crossover / hzPerBin), binLow + 1, binHigh - 1);
    const lowRange = Math.max(1, binCross - binLow);
    const highRange = Math.max(1, binHigh - binCross);

    const numSegments = 72;
    const angleStep = (Math.PI * 2) / numSegments;

    // Inner ring
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 140, 0, 0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Low band — inner segments (amber)
    for (let i = 0; i < numSegments; i++) {
        const t = i / numSegments;
        const binIdx = binLow + Math.floor(Math.pow(t, 1.3) * lowRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barLen = (val / 255) * (midR - innerR);

        const angle = angleStep * i - Math.PI / 2;
        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * (innerR + barLen);
        const y2 = cy + Math.sin(angle) * (innerR + barLen);

        const alpha = 0.4 + (val / 255) * 0.5;
        const color = bandColor(state.colorLowDim, state.colorLowBright, val / 255, alpha);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, (Math.PI * 2 * innerR) / numSegments - 1);
        applyGlow(ctx, color, 5);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        clearGlow(ctx);
    }

    // Mid ring divider
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(100, 100, 100, 0.15)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // High band — outer segments (cyan)
    for (let i = 0; i < numSegments; i++) {
        const t = i / numSegments;
        const binIdx = binCross + Math.floor(Math.pow(t, 1.4) * highRange);
        const val = state.smoothedFreq[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const barLen = (val / 255) * (maxR - midR);

        const angle = angleStep * i - Math.PI / 2;
        const x1 = cx + Math.cos(angle) * midR;
        const y1 = cy + Math.sin(angle) * midR;
        const x2 = cx + Math.cos(angle) * (midR + barLen);
        const y2 = cy + Math.sin(angle) * (midR + barLen);

        const alpha = 0.4 + (val / 255) * 0.5;
        const color = bandColor(state.colorHighDim, state.colorHighBright, val / 255, alpha);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * midR) / numSegments - 1);
        applyGlow(ctx, color, 3);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        clearGlow(ctx);
    }

    // Center circle
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 10, 10, 0.8)";
    ctx.fill();

    // Rotating indicator
    const rotAngle = elapsed / 2000;
    ctx.strokeStyle = PHOSPHOR_AMBER;
    ctx.lineWidth = 1;
    applyGlow(ctx, PHOSPHOR_AMBER, 4);
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 6, rotAngle, rotAngle + 0.5);
    ctx.stroke();
    clearGlow(ctx);
}

function drawWaveformSplit(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    const binCount = state.freqData.length;
    if (binCount === 0) return;

    const hzPerBin = state.sampleRate / (state.analyser?.fftSize ?? 2048);
    const binLow = Math.max(0, Math.floor(state.freqLow / hzPerBin));
    const binCross = clamp(Math.floor(state.crossover / hzPerBin), binLow + 1, binCount - 1);
    const bassRange = Math.max(1, binCross - binLow);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.4;
    const innerR = maxR * 0.12;

    // --- Shockwave rings on heavy hits ---
    if (state.bassHitDecay > 0.1) {
        const shockR = maxR * (1.0 + (1.0 - state.bassHitDecay) * 0.8);
        const alpha = state.bassHitDecay * 0.35;
        ctx.strokeStyle = hexRgba(state.colorLowBright, alpha);
        ctx.lineWidth = 2.5 * state.bassHitDecay;
        applyGlow(ctx, hexRgba(state.colorLowBright, alpha), 12);
        ctx.beginPath();
        ctx.arc(cx, cy, shockR, 0, Math.PI * 2);
        ctx.stroke();
        clearGlow(ctx);

        // Second shockwave, slightly delayed
        const shock2R = maxR * (0.8 + (1.0 - state.bassHitDecay) * 0.5);
        ctx.strokeStyle = hexRgba(state.colorLowDim, alpha * 0.5);
        ctx.lineWidth = 1.5 * state.bassHitDecay;
        ctx.beginPath();
        ctx.arc(cx, cy, shock2R, 0, Math.PI * 2);
        ctx.stroke();
    }

    // --- Radial bass segments — RAW data, no smoothing ---
    const numSeg = 48;
    const angleStep = (Math.PI * 2) / numSeg;

    for (let i = 0; i < numSeg; i++) {
        const t = i / numSeg;
        const binIdx = binLow + Math.floor(t * bassRange);
        const val = state.freqData[clamp(binIdx, 0, binCount - 1)] ?? 0;
        const segR = innerR + (val / 255) * (maxR - innerR);

        const angle = angleStep * i - Math.PI / 2;
        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * segR;
        const y2 = cy + Math.sin(angle) * segR;

        const intensity = val / 255;
        const alpha = 0.2 + intensity * 0.8;
        const color = bandColor(state.colorLowDim, state.colorLowBright, intensity, alpha);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2.5, (Math.PI * 2 * innerR) / numSeg);
        applyGlow(ctx, color, 4 + intensity * 12);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        clearGlow(ctx);
    }

    // --- Center core — sub-bass breathing circle ---
    const coreR = innerR * (0.6 + state.bassEnergy * 2.5);
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreGrad.addColorStop(0, hexRgba(state.colorLowBright, 0.15 + state.bassEnergy * 0.7));
    coreGrad.addColorStop(0.5, hexRgba(state.colorLowDim, 0.08 + state.bassEnergy * 0.4));
    coreGrad.addColorStop(1, hexRgba(state.colorLowDim, 0));
    applyGlow(ctx, hexRgba(state.colorLowBright, state.bassEnergy * 0.6), 18);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    clearGlow(ctx);

    // Inner ring
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 140, 0, ${0.1 + state.bassEnergy * 0.3})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- Bass hit full-screen flash ---
    if (state.bassHitDecay > 0.5) {
        ctx.fillStyle = hexRgba(state.colorLowBright, (state.bassHitDecay - 0.5) * 0.08);
        ctx.fillRect(0, 0, w, h);
    }

    // --- Waveform trace (foreground) ---
    const margin = 20;
    const waveH = h * 0.55;
    const waveY = h * 0.22;
    const plotW = w - margin * 2;

    // Ghost trace
    ctx.beginPath();
    ctx.strokeStyle = hexRgba(state.colorHighBright, 0.04);
    ctx.lineWidth = 1;
    for (let i = 0; i < plotW; i++) {
        const idx = Math.floor((i / plotW) * state.timeData.length);
        const val = state.timeData[idx] ?? 128;
        const y = waveY + (val / 255) * waveH;
        const jitter = Math.sin(elapsed / 200 + i * 0.3) * 1.5;
        if (i === 0) ctx.moveTo(margin + i, y + jitter);
        else ctx.lineTo(margin + i, y + jitter);
    }
    ctx.stroke();

    // Main waveform line — vertical gradient: dim at center, bright at extremes
    const waveGrad = ctx.createLinearGradient(0, waveY, 0, waveY + waveH);
    waveGrad.addColorStop(0, state.colorHighBright);
    waveGrad.addColorStop(0.3, hexRgba(state.colorHighBright, 0.7));
    waveGrad.addColorStop(0.45, state.colorHighDim);
    waveGrad.addColorStop(0.55, state.colorHighDim);
    waveGrad.addColorStop(0.7, hexRgba(state.colorHighBright, 0.7));
    waveGrad.addColorStop(1, state.colorHighBright);

    ctx.beginPath();
    ctx.strokeStyle = waveGrad;
    ctx.lineWidth = 1.8;
    applyGlow(ctx, state.colorHighBright, 8);
    for (let i = 0; i < plotW; i++) {
        const idx = Math.floor((i / plotW) * state.timeData.length);
        const val = state.timeData[idx] ?? 128;
        const y = waveY + (val / 255) * waveH;
        if (i === 0) ctx.moveTo(margin + i, y);
        else ctx.lineTo(margin + i, y);
    }
    ctx.stroke();
    clearGlow(ctx);

    // Labels
    ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText("BASS CANNON", margin + 4, waveY + 12);
    ctx.fillStyle = "rgba(255, 140, 0, 0.4)";
    ctx.textAlign = "center";
    ctx.fillText("SUB", cx, cy + maxR + 14);
    ctx.textAlign = "left";
}

function drawIdleAnimation(
    ctx: CanvasRenderingContext2D,
    state: AudioState,
    w: number,
    h: number,
    elapsed: number
): void {
    state.idlePhase += 0.02;
    const margin = 20;
    const plotW = w - margin * 2;
    const plotH = h - margin * 2 - 40;

    // Ambient noise floor bars — very dim, slowly undulating
    const numBars = 60;
    const barW = Math.max(2, plotW / numBars - 1);
    for (let i = 0; i < numBars; i++) {
        const val = 3 + Math.sin(state.idlePhase + i * 0.3) * 2 + Math.random() * 2;
        const barH = (val / 255) * plotH;
        const x = margin + i * (barW + 1);
        const y = margin + plotH - barH;
        ctx.fillStyle = `rgba(0, 255, 65, 0.08)`;
        ctx.fillRect(x, y, barW, barH);
    }

    // Status text
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    if (state.errorMsg) {
        ctx.fillStyle = `rgba(255, 80, 80, ${0.4 + Math.sin(elapsed / 800) * 0.1})`;
        ctx.fillText("CAPTURE FAILED", w / 2, h / 2 - 12);
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(255, 80, 80, 0.3)";
        // Word-wrap error message
        const words = state.errorMsg.split(" ");
        let line = "";
        let lineY = h / 2 + 6;
        for (const word of words) {
            const test = line + word + " ";
            if (ctx.measureText(test).width > w - 60 && line.length > 0) {
                ctx.fillText(line.trim(), w / 2, lineY);
                line = word + " ";
                lineY += 14;
            } else {
                line = test;
            }
        }
        if (line.trim()) ctx.fillText(line.trim(), w / 2, lineY);
    } else if (state.connecting) {
        ctx.fillStyle = `rgba(0, 255, 65, ${0.3 + Math.sin(elapsed / 400) * 0.15})`;
        ctx.fillText("CONNECTING...", w / 2, h / 2);
    } else {
        ctx.fillStyle = `rgba(0, 255, 65, ${0.2 + Math.sin(elapsed / 800) * 0.1})`;
        ctx.fillText("NO SIGNAL — CLICK TO CAPTURE AUDIO", w / 2, h / 2);
    }
    ctx.textAlign = "left";
}

function drawNowPlaying(ctx: CanvasRenderingContext2D, np: NowPlaying | null, w: number, h: number): void {
    if (!np) return;

    const bottomY = h - 28;
    const margin = 24;

    // Semi-transparent backdrop
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, bottomY - 8, w, 36);

    // Track info
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = PHOSPHOR_GREEN;
    applyGlow(ctx, PHOSPHOR_GREEN, 3);
    const text = `${np.track}  —  ${np.artist}  —  ${np.album}`;
    ctx.fillText(text, margin, bottomY + 8);
    clearGlow(ctx);
}

function createDrawFn(state: AudioState): DrawFunction {
    return (ctx, width, height, elapsed, delta) => {
        // Clear
        ctx.fillStyle = BG_DARK;
        ctx.fillRect(0, 0, width, height);

        // Seismic shake on intense bass
        let shakeX = 0,
            shakeY = 0;
        if (state.bassEnergy > 0.45 || state.bassHitDecay > 0.3) {
            const intensity = Math.max(state.bassEnergy - 0.4, 0) * 5 + state.bassHitDecay * 0.5;
            const shake = clamp(intensity, 0, 1);
            shakeX = (Math.random() - 0.5) * shake * 6;
            shakeY = (Math.random() - 0.5) * shake * 4;
            ctx.save();
            ctx.translate(shakeX, shakeY);
        }

        drawNoiseFloor(ctx, width, height);

        if (state.connected) {
            state.update();

            // Check if audio is actually playing (sum of frequencies)
            let energySum = 0;
            for (let i = 0; i < state.freqData.length; i++) {
                energySum += state.freqData[i];
            }
            const hasAudio = energySum > 500;

            if (hasAudio) {
                switch (state.mode) {
                    case "spectrum":
                        if (state.splitMode) {
                            drawSpectrumSplit(ctx, state, width, height, elapsed);
                        } else {
                            drawSpectrum(ctx, state, width, height, elapsed);
                        }
                        break;
                    case "waveform":
                        if (state.splitMode) {
                            drawWaveformSplit(ctx, state, width, height, elapsed);
                        } else {
                            drawWaveformViz(ctx, state, width, height, elapsed);
                        }
                        break;
                    case "circular":
                        if (state.splitMode) {
                            drawCircularSplit(ctx, state, width, height, elapsed);
                        } else {
                            drawCircularViz(ctx, state, width, height, elapsed);
                        }
                        break;
                    case "basscannon":
                        drawWaveformSplit(ctx, state, width, height, elapsed);
                        break;
                }
            } else {
                drawIdleAnimation(ctx, state, width, height, elapsed);
            }
        } else {
            drawIdleAnimation(ctx, state, width, height, elapsed);
        }

        drawNowPlaying(ctx, state.nowPlaying, width, height);
        drawCrtOverlay(ctx, width, height);

        // Restore shake transform
        if (shakeX !== 0 || shakeY !== 0) {
            ctx.restore();
        }

        // Static snow on intense bass — specs of white/colored noise
        if (state.bassEnergy > 0.4 || state.bassHitDecay > 0.4) {
            const snowIntensity = clamp(Math.max(state.bassEnergy - 0.35, 0) * 4 + state.bassHitDecay * 0.6, 0, 1);
            const numSpecs = Math.floor(snowIntensity * 120);
            for (let i = 0; i < numSpecs; i++) {
                const sx = Math.random() * width;
                const sy = Math.random() * height;
                const bright = 0.15 + Math.random() * snowIntensity * 0.6;
                // Mix of white and color-tinted snow
                if (Math.random() < 0.7) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${bright})`;
                } else {
                    ctx.fillStyle = hexRgba(state.colorLowBright, bright);
                }
                const sz = Math.random() < 0.9 ? 1 : 2;
                ctx.fillRect(sx, sy, sz, sz);
            }
        }

        // Mode label (top right)
        ctx.font = "8px 'JetBrains Mono', monospace";
        ctx.fillStyle = TEXT_DIM;
        ctx.textAlign = "right";
        const modeLabel = state.mode === "basscannon" ? "BASS CANNON" : state.mode.toUpperCase();
        ctx.fillText(modeLabel, width - 8, 14);
        ctx.textAlign = "left";
    };
}

// --- Now Playing Polling ---

// Both scripts check `application "Music" is running` first: that check does not launch the app,
// whereas a bare `tell application "Music"` relaunches it on every poll after the user quits it.
const METADATA_SCRIPT = `osascript -e 'if application "Music" is running then
  tell application "Music"
    if player state is playing then
      set t to name of current track
      set a to artist of current track
      set al to album of current track
      return t & "|||" & a & "|||" & al
    else
      return "STOPPED"
    end if
  end tell
else
  return "STOPPED"
end if' 2>/dev/null || echo ""`;

const ARTWORK_SCRIPT = `osascript -e 'if application "Music" is running then
  tell application "Music"
    if player state is playing then
      set artworks to artworks of current track
      if (count of artworks) > 0 then
        set artData to raw data of artwork 1 of current track
        set tmpPath to POSIX path of (path to temporary items folder) & "terminus-artwork.jpg"
        try
          set fRef to open for access tmpPath with write permission
          set eof fRef to 0
          write artData to fRef
          close access fRef
          return tmpPath
        on error
          try
            close access tmpPath
          end try
          return ""
        end try
      end if
    end if
    return ""
  end tell
end if
return ""' 2>/dev/null || echo ""`;

function useNowPlaying(stateRef: React.RefObject<AudioState>): void {
    React.useEffect(() => {
        let cancelled = false;

        const pollMetadata = async () => {
            try {
                const result = await getApi().execCommand(METADATA_SCRIPT);
                if (cancelled) return;
                const out = result.stdout?.trim();
                if (!out || out === "STOPPED" || out === "") {
                    if (stateRef.current) stateRef.current.nowPlaying = null;
                    return;
                }
                const parts = out.split("|||");
                if (parts.length === 3) {
                    const [track, artist, album] = parts;
                    const prev = stateRef.current?.nowPlaying;
                    const trackChanged = prev?.track !== track;

                    if (stateRef.current) {
                        stateRef.current.nowPlaying = {
                            track,
                            artist,
                            album,
                            artworkDataUrl: trackChanged ? null : (prev?.artworkDataUrl ?? null),
                        };
                    }

                    // Fetch artwork on track change
                    if (trackChanged) {
                        try {
                            const artResult = await getApi().execCommand(ARTWORK_SCRIPT);
                            if (cancelled) return;
                            const artPath = artResult.stdout?.trim();
                            if (artPath && stateRef.current?.nowPlaying) {
                                const dataUrl = await getApi().readFileBase64(artPath);
                                if (!cancelled && stateRef.current?.nowPlaying) {
                                    stateRef.current.nowPlaying.artworkDataUrl = dataUrl;
                                }
                            }
                        } catch {
                            // artwork fetch failed, not critical
                        }
                    }
                }
            } catch {
                // Music.app not running or script failed
            }
        };

        pollMetadata();
        const id = setInterval(pollMetadata, 4000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [stateRef]);
}

// --- Viz Controls (Colors + Attack/Release) ---

const VizControls: React.FC<{ stateRef: React.RefObject<AudioState>; split: boolean }> = ({ stateRef, split }) => {
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    const st = stateRef.current;
    if (!st) return null;

    const sync = (key: string, val: string | number) => {
        (st as any)[key] = val;
        forceUpdate();
        saveVizMeta({ [key]: val });
    };

    const colorInput = (val: string, key: string) => (
        <input
            type="color"
            value={val}
            onChange={(e) => sync(key, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{
                width: 14,
                height: 14,
                padding: 0,
                border: "1px solid rgba(0,255,65,0.2)",
                borderRadius: 2,
                background: "transparent",
                cursor: "pointer",
            }}
        />
    );

    const rangeInput = (val: number, key: string, label: string) => (
        <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span>{label}</span>
            <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={val}
                onChange={(e) => sync(key, parseFloat(e.target.value))}
                onClick={(e) => e.stopPropagation()}
                className="viz-ctrl-range"
            />
        </label>
    );

    const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, flexWrap: "nowrap" };
    const labelStyle: React.CSSProperties = {
        fontSize: 7,
        fontFamily: "'JetBrains Mono', monospace",
        whiteSpace: "nowrap" as const,
    };

    return (
        <div
            style={{
                position: "absolute",
                bottom: split ? 76 : 62,
                left: 20,
                right: 20,
                zIndex: 2,
                fontSize: 7,
                fontFamily: "'JetBrains Mono', monospace",
                color: "rgba(0, 255, 65, 0.35)",
                display: "flex",
                flexDirection: "column",
                gap: 3,
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <style>{`
                .viz-ctrl-range { -webkit-appearance: none; width: 36px; height: 2px; background: rgba(0,255,65,0.15); outline: none; border-radius: 1px; }
                .viz-ctrl-range::-webkit-slider-thumb { -webkit-appearance: none; width: 7px; height: 7px; border-radius: 50%; background: rgba(0,255,65,0.5); border: 1px solid rgba(0,255,65,0.6); cursor: grab; }
            `}</style>
            {split ? (
                <>
                    <div style={rowStyle}>
                        <span style={{ ...labelStyle, color: "rgba(255,176,0,0.5)" }}>LOW</span>
                        {colorInput(st.colorLowDim, "colorLowDim")}
                        {colorInput(st.colorLowBright, "colorLowBright")}
                        {rangeInput(st.lowAttack, "lowAttack", "A")}
                        {rangeInput(st.lowRelease, "lowRelease", "R")}
                    </div>
                    <div style={rowStyle}>
                        <span style={{ ...labelStyle, color: "rgba(0,200,220,0.5)" }}>HIGH</span>
                        {colorInput(st.colorHighDim, "colorHighDim")}
                        {colorInput(st.colorHighBright, "colorHighBright")}
                        {rangeInput(st.highAttack, "highAttack", "A")}
                        {rangeInput(st.highRelease, "highRelease", "R")}
                    </div>
                </>
            ) : (
                <div style={rowStyle}>
                    {colorInput(st.colorLowDim, "colorLowDim")}
                    {colorInput(st.colorLowBright, "colorLowBright")}
                    {rangeInput(st.attack, "attack", "ATK")}
                    {rangeInput(st.release, "release", "REL")}
                </div>
            )}
        </div>
    );
};

// --- Frequency Range Slider ---

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const freqToPos = (f: number): number => Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN);
const posToFreq = (p: number): number => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, clamp(p, 0, 1));
const formatFreq = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}Hz`);

const FreqRangeSlider: React.FC<{
    stateRef: React.RefObject<AudioState>;
    split: boolean;
    onSplitChange: (v: boolean) => void;
}> = ({ stateRef, split, onSplitChange }) => {
    const initLow = stateRef.current?.freqLow ?? 30;
    const initHigh = stateRef.current?.freqHigh ?? 16000;
    const initCross = stateRef.current?.crossover ?? 250;
    const [low, setLow] = React.useState(initLow);
    const [high, setHigh] = React.useState(initHigh);
    const [crossover, setCrossover] = React.useState(initCross);
    const trackRef = React.useRef<HTMLDivElement>(null);
    const valsRef = React.useRef({ low: initLow, high: initHigh, crossover: initCross });

    const handleThumbDown = (thumb: "low" | "high" | "cross") => (e: React.PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();

        const move = (me: PointerEvent) => {
            const track = trackRef.current;
            if (!track) return;
            const rect = track.getBoundingClientRect();
            const pos = clamp((me.clientX - rect.left) / rect.width, 0, 1);
            const freq = posToFreq(pos);

            let { low: nL, high: nH, crossover: nC } = valsRef.current;
            if (thumb === "low") {
                nL = clamp(freq, FREQ_MIN, (split ? nC : nH) - 100);
            } else if (thumb === "high") {
                nH = clamp(freq, (split ? nC : nL) + 100, FREQ_MAX);
            } else {
                nC = clamp(freq, nL + 50, nH - 50);
            }

            valsRef.current = { low: nL, high: nH, crossover: nC };
            setLow(nL);
            setHigh(nH);
            setCrossover(nC);
            if (stateRef.current) {
                stateRef.current.freqLow = nL;
                stateRef.current.freqHigh = nH;
                stateRef.current.crossover = nC;
            }
        };

        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            const v = valsRef.current;
            saveVizMeta({ freqLow: v.low, freqHigh: v.high, crossover: v.crossover });
        };

        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    };

    const toggleSplit = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !split;
        onSplitChange(next);
        if (stateRef.current) {
            stateRef.current.splitMode = next;
        }
        saveVizMeta({ splitMode: next });
    };

    const lowPos = freqToPos(low) * 100;
    const highPos = freqToPos(high) * 100;
    const crossPos = freqToPos(crossover) * 100;

    const thumbBase: React.CSSProperties = {
        position: "absolute",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: 10,
        height: 10,
        borderRadius: "50%",
        cursor: "grab",
    };
    const greenThumb: React.CSSProperties = {
        ...thumbBase,
        background: "rgba(0, 255, 65, 0.4)",
        border: "1px solid rgba(0, 255, 65, 0.6)",
        boxShadow: "0 0 6px rgba(0, 255, 65, 0.2)",
    };
    const crossThumb: React.CSSProperties = {
        ...thumbBase,
        width: 12,
        height: 12,
        background: "rgba(255, 176, 0, 0.5)",
        border: "1px solid rgba(255, 176, 0, 0.7)",
        boxShadow: "0 0 8px rgba(255, 176, 0, 0.3)",
    };

    const labelStyle: React.CSSProperties = {
        position: "absolute",
        top: -2,
        transform: "translateX(-50%)",
        fontSize: 7,
        fontFamily: "'JetBrains Mono', monospace",
        pointerEvents: "none",
        whiteSpace: "nowrap",
    };

    return (
        <div
            style={{
                position: "absolute",
                bottom: 38,
                left: 20,
                right: 20,
                height: 20,
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <div
                ref={trackRef}
                style={{ position: "relative", flex: 1, height: "100%", display: "flex", alignItems: "center" }}
            >
                {/* Full track */}
                <div
                    style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: "50%",
                        transform: "translateY(-50%)",
                        height: 2,
                        background: "rgba(0, 255, 65, 0.08)",
                        borderRadius: 1,
                    }}
                />
                {/* Active range(s) */}
                {split ? (
                    <>
                        <div
                            style={{
                                position: "absolute",
                                left: `${lowPos}%`,
                                width: `${crossPos - lowPos}%`,
                                top: "50%",
                                transform: "translateY(-50%)",
                                height: 2,
                                background: "rgba(255, 140, 0, 0.3)",
                                borderRadius: 1,
                            }}
                        />
                        <div
                            style={{
                                position: "absolute",
                                left: `${crossPos}%`,
                                width: `${highPos - crossPos}%`,
                                top: "50%",
                                transform: "translateY(-50%)",
                                height: 2,
                                background: "rgba(0, 200, 220, 0.3)",
                                borderRadius: 1,
                            }}
                        />
                    </>
                ) : (
                    <div
                        style={{
                            position: "absolute",
                            left: `${lowPos}%`,
                            width: `${highPos - lowPos}%`,
                            top: "50%",
                            transform: "translateY(-50%)",
                            height: 2,
                            background: "rgba(0, 255, 65, 0.3)",
                            borderRadius: 1,
                        }}
                    />
                )}
                {/* Low thumb */}
                <div onPointerDown={handleThumbDown("low")} style={{ ...greenThumb, left: `${lowPos}%` }} />
                {/* Crossover thumb (split mode only) */}
                {split && (
                    <div onPointerDown={handleThumbDown("cross")} style={{ ...crossThumb, left: `${crossPos}%` }} />
                )}
                {/* High thumb */}
                <div onPointerDown={handleThumbDown("high")} style={{ ...greenThumb, left: `${highPos}%` }} />
                {/* Low label */}
                <div style={{ ...labelStyle, left: `${lowPos}%`, color: "rgba(0, 255, 65, 0.35)" }}>
                    {formatFreq(low)}
                </div>
                {/* Crossover label */}
                {split && (
                    <div style={{ ...labelStyle, left: `${crossPos}%`, color: "rgba(255, 176, 0, 0.45)" }}>
                        {formatFreq(crossover)}
                    </div>
                )}
                {/* High label */}
                <div style={{ ...labelStyle, left: `${highPos}%`, color: "rgba(0, 255, 65, 0.35)" }}>
                    {formatFreq(high)}
                </div>
            </div>
            {/* Split toggle */}
            <div
                onClick={toggleSplit}
                style={{
                    fontSize: 7,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: split ? "rgba(255, 176, 0, 0.7)" : "rgba(0, 255, 65, 0.25)",
                    cursor: "pointer",
                    padding: "2px 4px",
                    border: `1px solid ${split ? "rgba(255, 176, 0, 0.4)" : "rgba(0, 255, 65, 0.12)"}`,
                    borderRadius: 2,
                    whiteSpace: "nowrap",
                    userSelect: "none",
                    transition: "color 0.2s, border-color 0.2s",
                    boxShadow: split ? "0 0 6px rgba(255, 176, 0, 0.15)" : "none",
                }}
            >
                SPLIT
            </div>
        </div>
    );
};

// --- Settings Persistence (file-based, survives panel close/reopen) ---

const VIZ_SETTINGS_KEYS = [
    "mode",
    "freqLow",
    "freqHigh",
    "crossover",
    "splitMode",
    "colorLowDim",
    "colorLowBright",
    "colorHighDim",
    "colorHighBright",
    "attack",
    "release",
    "lowAttack",
    "lowRelease",
    "highAttack",
    "highRelease",
] as const;

function getVizPrefsPath(): string {
    const configDir = getApi().getConfigDir();
    return configDir + "/visualizer-prefs.json";
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSave: Record<string, any> = {};

function saveVizSetting(key: string, val: any): void {
    _pendingSave[key] = val;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
        const path = getVizPrefsPath();
        try {
            const existing = await getApi().readTextFile(path);
            const prefs = existing ? JSON.parse(existing) : {};
            Object.assign(prefs, _pendingSave);
            _pendingSave = {};
            await getApi().writeTextFile(path, JSON.stringify(prefs, null, 2));
        } catch (e) {
            console.warn("[visualizer] failed to save prefs:", e);
        }
    }, 300);
}

function saveVizMeta(meta: Record<string, any>): void {
    for (const [k, v] of Object.entries(meta)) {
        saveVizSetting(k, v);
    }
}

async function loadVizSettingsFromFile(state: AudioState): Promise<{ split: boolean; mode: VizMode }> {
    let split = state.splitMode;
    let mode = state.mode;
    try {
        const path = getVizPrefsPath();
        const raw = await getApi().readTextFile(path);
        if (!raw) return { split, mode };
        const prefs = JSON.parse(raw);
        for (const key of VIZ_SETTINGS_KEYS) {
            if (prefs[key] != null) {
                (state as any)[key] = prefs[key];
            }
        }
        split = state.splitMode;
        mode = state.mode;
    } catch (e) {
        console.warn("[visualizer] failed to load prefs:", e);
    }
    return { split, mode };
}

// --- ViewModel ---

class VisualizerViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    blockAtom: jotai.Atom<Block>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    viewComponent: ViewComponent;
    noPadding: jotai.Atom<boolean>;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.viewType = "visualizer";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("music");
        this.viewName = jotai.atom("Visualizer");
        this.viewComponent = VisualizerView;
        this.noPadding = jotai.atom(true);
        this.endIconButtons = jotai.atom([
            {
                elemtype: "iconbutton",
                icon: "chart-bar",
                title: "Cycle visualization mode",
                click: () => {
                    // Handled via event dispatch from component
                    window.dispatchEvent(new CustomEvent("visualizer:cycle-mode"));
                },
            },
        ]);
    }
}

// --- View Component ---

const VisualizerView: React.FC<ViewComponentProps<VisualizerViewModel>> = React.memo(({ model }) => {
    const { canvasRef, containerRef, width, height } = useCanvasSetup();
    const stateRef = React.useRef(new AudioState());
    const [connected, setConnected] = React.useState(false);
    const [split, setSplit] = React.useState(false);

    // Load saved settings from file on mount
    React.useEffect(() => {
        loadVizSettingsFromFile(stateRef.current).then(({ split: s }) => {
            setSplit(s);
        });
    }, []);

    // Now Playing metadata polling
    useNowPlaying(stateRef);

    // Mode cycling via header button
    React.useEffect(() => {
        const modes: VizMode[] = ["spectrum", "waveform", "circular", "basscannon"];
        const handler = () => {
            const state = stateRef.current;
            const idx = modes.indexOf(state.mode);
            state.mode = modes[(idx + 1) % modes.length];
            saveVizMeta({ mode: state.mode });
        };
        window.addEventListener("visualizer:cycle-mode", handler);
        return () => window.removeEventListener("visualizer:cycle-mode", handler);
    }, []);

    // Click to connect audio
    const handleClick = React.useCallback(async () => {
        const state = stateRef.current;
        if (state.connected) return;
        const ok = await state.connect();
        if (ok) setConnected(true);
    }, []);

    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            stateRef.current.disconnect();
        };
    }, []);

    const drawFn = React.useMemo(() => createDrawFn(stateRef.current), []);

    useAnimationLoop(canvasRef, width, height, drawFn);

    return (
        <div
            ref={containerRef}
            onClick={handleClick}
            style={{
                position: "relative",
                width: "100%",
                height: "100%",
                background: BG_DARK,
                overflow: "hidden",
                cursor: connected ? "default" : "pointer",
            }}
        >
            <canvas ref={canvasRef} style={{ display: "block" }} />
            {connected && <VizControls stateRef={stateRef} split={split} />}
            {connected && <FreqRangeSlider stateRef={stateRef} split={split} onSplitChange={setSplit} />}
        </div>
    );
});
VisualizerView.displayName = "VisualizerView";

export { VisualizerViewModel };
