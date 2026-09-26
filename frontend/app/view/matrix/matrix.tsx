// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { WOS } from "@/store/global";
import * as jotai from "jotai";
import * as React from "react";

import { applyGlow, BG_BLACK, clearGlow, PHOSPHOR_GREEN, PHOSPHOR_GREEN_MID } from "../vizutil/vizcolors";
import { getFleetFragments, getInboxEntries, subscribeFleet, subscribeInbox } from "../vizutil/vizdata";
import { DrawFunction, randomRange, useAnimationLoop, useCanvasSetup } from "../vizutil/vizutil";

// --- Types ---

interface Column {
    x: number;
    y: number;
    speed: number;
    chars: string[];
    trailLength: number;
    dataFragment: string | null;
    dataOffset: number;
    dataTimer: number;
}

// --- Character Pools ---

// Katakana range: U+30A0 to U+30FF
function randomKatakana(): string {
    return String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96));
}

function randomChar(): string {
    if (Math.random() < 0.4) {
        return randomKatakana();
    }
    // Mix of digits, uppercase, and symbols
    const pool = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&<>{}[]";
    return pool[Math.floor(Math.random() * pool.length)];
}

// --- Data Fragment Source ---

const AGENT_NAMES = [
    "JULIAN",
    "HEAVY",
    "DECKER",
    "SELLIVAN",
    "QIN",
    "LEE",
    "MANU",
    "ELIZA",
    "ADONI",
    "RENNER",
    "SAMANTHA",
    "SIDDIG",
    "KOGAN",
    "YADAV",
];

function getDataFragments(): string[] {
    const fragments: string[] = [...AGENT_NAMES];

    const fleet = getFleetFragments();
    for (const f of fleet) {
        if (f.commitHash) fragments.push(f.commitHash.slice(0, 7).toUpperCase());
        if (f.summary) {
            // Pull short words/phrases from summaries
            const words = f.summary.split(/\s+/).filter((w) => w.length >= 4 && w.length <= 12);
            fragments.push(...words.slice(0, 3));
        }
    }

    const inbox = getInboxEntries();
    for (const e of inbox) {
        if (typeof e?.from === "string") fragments.push(e.from.toUpperCase());
        if (typeof e?.signal === "string" && e.signal) fragments.push(e.signal.toUpperCase());
    }

    return fragments;
}

// --- Matrix State ---

class MatrixState {
    columns: Column[] = [];
    charWidth: number = 0;
    charHeight: number = 0;
    lastDataInject: number = 0;
    initialized: boolean = false;

    init(width: number, height: number, ctx: CanvasRenderingContext2D): void {
        ctx.font = "14px 'JetBrains Mono', 'Menlo', monospace";
        const metrics = ctx.measureText("W");
        this.charWidth = Math.ceil(metrics.width);
        this.charHeight = 18;

        const numCols = Math.floor(width / this.charWidth);
        this.columns = [];
        for (let i = 0; i < numCols; i++) {
            this.columns.push(this.makeColumn(i, height));
        }
        this.initialized = true;
    }

    makeColumn(index: number, height: number): Column {
        return {
            x: index * this.charWidth,
            y: randomRange(-height, 0),
            speed: randomRange(1.5, 5),
            chars: Array.from({ length: Math.floor(randomRange(8, 30)) }, randomChar),
            trailLength: Math.floor(randomRange(8, 25)),
            dataFragment: null,
            dataOffset: 0,
            dataTimer: 0,
        };
    }

    resetColumn(col: Column, height: number): void {
        col.y = randomRange(-height * 0.5, -20);
        col.speed = randomRange(1.5, 5);
        col.chars = Array.from({ length: Math.floor(randomRange(8, 30)) }, randomChar);
        col.trailLength = Math.floor(randomRange(8, 25));
        col.dataFragment = null;
        col.dataOffset = 0;
        col.dataTimer = 0;
    }

    resize(width: number, height: number, ctx: CanvasRenderingContext2D): void {
        ctx.font = "14px 'JetBrains Mono', 'Menlo', monospace";
        const metrics = ctx.measureText("W");
        this.charWidth = Math.ceil(metrics.width);

        const numCols = Math.floor(width / this.charWidth);
        while (this.columns.length < numCols) {
            this.columns.push(this.makeColumn(this.columns.length, height));
        }
        if (this.columns.length > numCols) {
            this.columns.length = numCols;
        }
        // Update x positions
        for (let i = 0; i < this.columns.length; i++) {
            this.columns[i].x = i * this.charWidth;
        }
    }
}

// --- Draw ---

function createDrawFn(state: MatrixState): DrawFunction {
    return (ctx, width, height, elapsed, delta) => {
        if (!state.initialized) {
            state.init(width, height, ctx);
        }

        // Fade previous frame (creates trail effect)
        ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
        ctx.fillRect(0, 0, width, height);

        ctx.font = "14px 'JetBrains Mono', 'Menlo', monospace";

        // Inject data fragments periodically
        if (elapsed - state.lastDataInject > 3000) {
            state.lastDataInject = elapsed;
            const fragments = getDataFragments();
            if (fragments.length > 0 && state.columns.length > 0) {
                // Pick 1-3 random columns to inject data into
                const count = Math.min(3, Math.floor(Math.random() * 3) + 1);
                for (let i = 0; i < count; i++) {
                    const col = state.columns[Math.floor(Math.random() * state.columns.length)];
                    col.dataFragment = fragments[Math.floor(Math.random() * fragments.length)];
                    col.dataOffset = 0;
                    col.dataTimer = elapsed;
                }
            }
        }

        // Draw columns
        for (const col of state.columns) {
            col.y += col.speed * (delta / 16);

            // Randomly mutate one character in the trail
            if (Math.random() < 0.03 && col.chars.length > 0) {
                const idx = Math.floor(Math.random() * col.chars.length);
                col.chars[idx] = randomChar();
            }

            const isDataCol = col.dataFragment && elapsed - col.dataTimer < 5000;

            for (let j = 0; j < col.chars.length; j++) {
                const charY = col.y + j * state.charHeight;

                // Skip if off screen
                if (charY < -state.charHeight || charY > height + state.charHeight) continue;

                // Determine character to draw
                let ch: string;
                const distFromHead = col.chars.length - 1 - j;

                if (isDataCol && j >= col.dataOffset && j < col.dataOffset + col.dataFragment.length) {
                    // Data fragment character
                    ch = col.dataFragment[j - col.dataOffset];
                } else {
                    ch = col.chars[j];
                }

                // Color based on position in trail
                if (j === col.chars.length - 1) {
                    // Leading character — brightest white-green
                    ctx.fillStyle = "#ffffff";
                    if (isDataCol) {
                        applyGlow(ctx, PHOSPHOR_GREEN, 8);
                    } else {
                        applyGlow(ctx, PHOSPHOR_GREEN, 4);
                    }
                } else if (distFromHead < 3) {
                    // Near the head — bright green
                    ctx.fillStyle = isDataCol ? "#88ff88" : PHOSPHOR_GREEN;
                    clearGlow(ctx);
                } else if (distFromHead < col.trailLength * 0.5) {
                    // Mid trail
                    ctx.fillStyle = isDataCol ? PHOSPHOR_GREEN : PHOSPHOR_GREEN_MID;
                    clearGlow(ctx);
                } else {
                    // Tail — dim
                    const alpha = Math.max(0.1, 1 - distFromHead / col.trailLength);
                    ctx.fillStyle = isDataCol ? `rgba(0, 255, 65, ${alpha * 0.8})` : `rgba(0, 170, 42, ${alpha * 0.5})`;
                    clearGlow(ctx);
                }

                ctx.fillText(ch, col.x, charY);
            }

            clearGlow(ctx);

            // Reset column if it's scrolled fully past the bottom
            if (col.y > height + col.chars.length * state.charHeight) {
                state.resetColumn(col, height);
            }
        }
    };
}

// --- ViewModel ---

class MatrixViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    blockAtom: jotai.Atom<Block>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    viewComponent: ViewComponent;
    noPadding: jotai.Atom<boolean>;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.viewType = "matrix";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("binary");
        this.viewName = jotai.atom("Matrix");
        this.viewComponent = MatrixView;
        this.noPadding = jotai.atom(true);
    }
}

// --- View Component ---

const MatrixView: React.FC<ViewComponentProps<MatrixViewModel>> = React.memo(({ model }) => {
    const { canvasRef, containerRef, width, height } = useCanvasSetup();
    const stateRef = React.useRef(new MatrixState());

    // Subscribe to data sources
    React.useEffect(() => {
        const unsub1 = subscribeFleet();
        const unsub2 = subscribeInbox();
        return () => {
            unsub1();
            unsub2();
        };
    }, []);

    // Handle resize
    React.useEffect(() => {
        if (width > 0 && height > 0 && stateRef.current.initialized) {
            const canvas = canvasRef.current;
            if (canvas) {
                const ctx = canvas.getContext("2d");
                if (ctx) stateRef.current.resize(width, height, ctx);
            }
        }
    }, [width, height]);

    const drawFn = React.useMemo(() => createDrawFn(stateRef.current), []);

    useAnimationLoop(canvasRef, width, height, drawFn);

    return (
        <div
            ref={containerRef}
            style={{
                width: "100%",
                height: "100%",
                background: BG_BLACK,
                overflow: "hidden",
            }}
        >
            <canvas ref={canvasRef} style={{ display: "block" }} />
        </div>
    );
});
MatrixView.displayName = "MatrixView";

export { MatrixViewModel };
