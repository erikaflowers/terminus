// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { AgentColorTable, getRemoteConfig, getTmuxCmd } from "@/app/store/agents";
import { getApi } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { WOS } from "@/store/global";
import * as jotai from "jotai";
import * as React from "react";

import { applyGlow, BG_BLACK, clearGlow } from "../vizutil/vizcolors";
import {
    getFleetFragments,
    getInboxEntries,
    subscribeFleet,
    subscribeInbox,
    type InboxEntry,
} from "../vizutil/vizdata";
import { clamp, DrawFunction, lerp, randomRange, useAnimationLoop, useCanvasSetup } from "../vizutil/vizutil";

// --- Types ---

interface GraphNode {
    id: string;
    label: string;
    color: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    baseRadius: number;
    activity: number; // 0-1, decays over time
    isActive: boolean; // has tmux session
    pulsePhase: number;
}

interface GraphEdge {
    from: string;
    to: string;
}

interface EdgeParticle {
    from: string;
    to: string;
    t: number;
    speed: number;
    color: string;
}

// --- Graph State ---

const REPULSION = 1200;
const SPRING_K = 0.006;
const CENTER_GRAVITY = 0.005;
const DAMPING = 0.9;
const REST_LENGTH = 150;

class GraphState {
    nodes: Map<string, GraphNode> = new Map();
    edges: GraphEdge[] = [];
    particles: EdgeParticle[] = [];
    lastTmuxPoll: number = 0;
    lastInboxKey: string | null = null;
    initialized: boolean = false;

    init(width: number, height: number): void {
        const entries = Object.entries(AgentColorTable);
        const count = entries.length;
        const cx = width / 2;
        const cy = height / 2;

        entries.forEach(([name, info], i) => {
            const angle = (i / count) * Math.PI * 2;
            const dist = Math.min(width, height) * 0.38;
            const isSamantha = name === "samantha";

            this.nodes.set(name, {
                id: name,
                label: name.charAt(0).toUpperCase() + name.slice(1),
                color: info.color,
                x: isSamantha ? cx : cx + Math.cos(angle) * dist,
                y: isSamantha ? cy : cy + Math.sin(angle) * dist,
                vx: 0,
                vy: 0,
                radius: isSamantha ? 18 : 12,
                baseRadius: isSamantha ? 18 : 12,
                activity: 0,
                isActive: false,
                pulsePhase: Math.random() * Math.PI * 2,
            });
        });

        // Create molecule-like bond structure
        // Primary bonds: everyone connects to samantha (hub)
        const names = Array.from(this.nodes.keys());
        for (const name of names) {
            if (name !== "samantha") {
                this.edges.push({ from: name, to: "samantha" });
            }
        }
        // Secondary bonds: connect neighbors in the ring for molecule lattice
        const nonSam = names.filter((n) => n !== "samantha");
        for (let i = 0; i < nonSam.length; i++) {
            const next = nonSam[(i + 1) % nonSam.length];
            this.edges.push({ from: nonSam[i], to: next });
        }
        // Tertiary bonds: a few cross-links for structural rigidity
        for (let i = 0; i < nonSam.length; i += 3) {
            const across = nonSam[(i + Math.floor(nonSam.length / 2)) % nonSam.length];
            if (across !== nonSam[i]) {
                this.edges.push({ from: nonSam[i], to: across });
            }
        }

        this.initialized = true;
    }

    updateActivity(): void {
        const fragments = getFleetFragments();
        const agentCounts = new Map<string, number>();
        for (const f of fragments) {
            const key = f.agentName.toLowerCase();
            agentCounts.set(key, (agentCounts.get(key) || 0) + 1);
        }

        const maxCount = Math.max(1, ...agentCounts.values());
        for (const [name, node] of this.nodes) {
            const count = agentCounts.get(name) || 0;
            const targetActivity = clamp(count / maxCount, 0, 1);
            // Smooth approach
            node.activity = lerp(node.activity, targetActivity, 0.05);
        }

        // Check for new relay messages → spawn particles
        // The inbox is a sliding window (tail -50), so its length stops growing; track the last entry
        // we've seen (by ts + sender/recipient/signal) and treat everything after it as new.
        const inbox = getInboxEntries();
        const entryKey = (e: InboxEntry) => `${e.ts}|${e.from}|${e.to ?? ""}|${e.signal ?? ""}`;
        if (inbox.length > 0) {
            const lastKey = entryKey(inbox[inbox.length - 1]);
            if (lastKey !== this.lastInboxKey) {
                let start = 0;
                if (this.lastInboxKey != null) {
                    for (let i = inbox.length - 1; i >= 0; i--) {
                        if (entryKey(inbox[i]) === this.lastInboxKey) {
                            start = i + 1;
                            break;
                        }
                    }
                }
                this.spawnInboxParticles(inbox.slice(start));
                this.lastInboxKey = lastKey;
            }
        }
    }

    spawnInboxParticles(newEntries: InboxEntry[]): void {
        for (const entry of newEntries) {
            if (typeof entry?.from !== "string") continue;
            const fromKey = entry.from.toLowerCase();
            const toKey = (typeof entry.to === "string" && entry.to ? entry.to : "samantha").toLowerCase();
            if (this.nodes.has(fromKey) && this.nodes.has(toKey)) {
                const fromNode = this.nodes.get(fromKey);
                this.particles.push({
                    from: fromKey,
                    to: toKey,
                    t: 0,
                    speed: randomRange(0.008, 0.02),
                    color: fromNode.color,
                });
                // Boost activity on sender
                fromNode.activity = Math.min(1, fromNode.activity + 0.5);
            }
        }
    }

    stepPhysics(width: number, height: number, delta: number): void {
        const cx = width / 2;
        const cy = height / 2;
        const dt = Math.min(delta / 16, 3); // cap dt to prevent explosions

        const nodeArr = Array.from(this.nodes.values());

        // Repulsion between all pairs
        for (let i = 0; i < nodeArr.length; i++) {
            for (let j = i + 1; j < nodeArr.length; j++) {
                const a = nodeArr[i];
                const b = nodeArr[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1) dist = 1;
                const force = REPULSION / (dist * dist);
                const fx = (dx / dist) * force * dt;
                const fy = (dy / dist) * force * dt;
                a.vx -= fx;
                a.vy -= fy;
                b.vx += fx;
                b.vy += fy;
            }
        }

        // Spring attraction along edges
        for (const edge of this.edges) {
            const a = this.nodes.get(edge.from);
            const b = this.nodes.get(edge.to);
            if (!a || !b) continue;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) dist = 1;
            const displacement = dist - REST_LENGTH;
            const force = SPRING_K * displacement * dt;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
        }

        // Center gravity
        for (const node of nodeArr) {
            node.vx += (cx - node.x) * CENTER_GRAVITY * dt;
            node.vy += (cy - node.y) * CENTER_GRAVITY * dt;
        }

        // Apply velocity with damping + Brownian drift
        for (const node of nodeArr) {
            // Brownian motion — gentle random nudges for molecular float
            node.vx += (Math.random() - 0.5) * 0.15 * dt;
            node.vy += (Math.random() - 0.5) * 0.15 * dt;

            // Slow sine drift so the whole structure gently rotates/breathes
            const driftAngle = Date.now() / 8000 + node.pulsePhase;
            node.vx += Math.cos(driftAngle) * 0.02 * dt;
            node.vy += Math.sin(driftAngle) * 0.02 * dt;

            node.vx *= DAMPING;
            node.vy *= DAMPING;
            node.x += node.vx * dt;
            node.y += node.vy * dt;

            // Soft clamp — bounce gently off walls
            const pad = 40;
            if (node.x < pad) {
                node.x = pad;
                node.vx *= -0.3;
            }
            if (node.x > width - pad) {
                node.x = width - pad;
                node.vx *= -0.3;
            }
            if (node.y < pad) {
                node.y = pad;
                node.vy *= -0.3;
            }
            if (node.y > height - pad) {
                node.y = height - pad;
                node.vy *= -0.3;
            }
        }

        // Advance particles
        this.particles = this.particles.filter((p) => {
            p.t += p.speed * dt;
            return p.t < 1;
        });
    }
}

// --- Draw ---

function createDrawFn(state: GraphState): DrawFunction {
    // Persistent ambient particles for visual noise
    let ambientParticles: {
        x: number;
        y: number;
        vx: number;
        vy: number;
        life: number;
        maxLife: number;
        size: number;
        color: string;
    }[] = [];
    let lastAmbientSpawn = 0;

    return (ctx, width, height, elapsed, delta) => {
        if (!state.initialized) {
            state.init(width, height);
        }

        // Update from data sources
        state.updateActivity();

        // Step physics
        state.stepPhysics(width, height, delta);

        // Clear with slight trail for motion blur
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(0, 0, width, height);

        // Background grid (faint hex pattern)
        ctx.strokeStyle = "rgba(255, 255, 255, 0.015)";
        ctx.lineWidth = 0.5;
        const gridSpacing = 40;
        for (let x = 0; x < width; x += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        for (let y = 0; y < height; y += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Spawn ambient floating particles
        if (elapsed - lastAmbientSpawn > 200) {
            lastAmbientSpawn = elapsed;
            const nodeArr = Array.from(state.nodes.values());
            if (nodeArr.length > 0) {
                const source = nodeArr[Math.floor(Math.random() * nodeArr.length)];
                const angle = Math.random() * Math.PI * 2;
                ambientParticles.push({
                    x: source.x + Math.cos(angle) * source.radius * 2,
                    y: source.y + Math.sin(angle) * source.radius * 2,
                    vx: Math.cos(angle) * randomRange(0.2, 0.8),
                    vy: Math.sin(angle) * randomRange(0.2, 0.8),
                    life: 0,
                    maxLife: randomRange(60, 180),
                    size: randomRange(0.5, 2),
                    color: source.color,
                });
            }
        }
        // Update and draw ambient particles
        ambientParticles = ambientParticles.filter((p) => {
            p.x += p.vx;
            p.y += p.vy;
            p.life++;
            if (p.life >= p.maxLife) return false;
            const alpha = 1 - p.life / p.maxLife;
            ctx.fillStyle = `rgba(${hexToRgb(p.color)}, ${alpha * 0.3})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            return true;
        });
        if (ambientParticles.length > 200) ambientParticles = ambientParticles.slice(-150);

        // Draw molecular bonds (connector lines)
        for (const edge of state.edges) {
            const a = state.nodes.get(edge.from);
            const b = state.nodes.get(edge.to);
            if (!a || !b) continue;

            const activity = Math.max(a.activity, b.activity);
            const isSamanthaEdge = edge.from === "samantha" || edge.to === "samantha";
            const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

            // Bond glow (bright and visible)
            const bondAlpha = isSamanthaEdge ? 0.35 + activity * 0.3 : 0.18 + activity * 0.2;
            const bondWidth = isSamanthaEdge ? 2.5 : 1.5;

            // Gradient bond from node A's color to node B's color
            const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
            grad.addColorStop(0, `rgba(${hexToRgb(a.color)}, ${bondAlpha})`);
            grad.addColorStop(1, `rgba(${hexToRgb(b.color)}, ${bondAlpha})`);

            ctx.strokeStyle = grad;
            ctx.lineWidth = bondWidth;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();

            // Animated flow dots along the bond — bright and visible
            const dotCount = isSamanthaEdge ? 3 : 2;
            for (let d = 0; d < dotCount; d++) {
                const t = (elapsed / 2500 + d / dotCount + edge.from.charCodeAt(0) * 0.01) % 1;
                const dx = lerp(a.x, b.x, t);
                const dy = lerp(a.y, b.y, t);
                applyGlow(ctx, a.color, 6);
                ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + activity * 0.4})`;
                ctx.beginPath();
                ctx.arc(dx, dy, 2.5 + activity * 1.5, 0, Math.PI * 2);
                ctx.fill();
                clearGlow(ctx);
            }

            // Distance label at midpoint for hub connections only
            if (isSamanthaEdge) {
                const mx = (a.x + b.x) / 2;
                const my = (a.y + b.y) / 2;
                ctx.font = "7px 'JetBrains Mono', monospace";
                ctx.fillStyle = `rgba(255, 255, 255, ${0.06 + activity * 0.08})`;
                ctx.textAlign = "center";
                ctx.fillText(`${Math.round(dist)}`, mx, my - 3);
            }
        }
        ctx.textAlign = "left";

        // Draw edge particles (relay messages)
        for (const p of state.particles) {
            const a = state.nodes.get(p.from);
            const b = state.nodes.get(p.to);
            if (!a || !b) continue;

            const px = lerp(a.x, b.x, p.t);
            const py = lerp(a.y, b.y, p.t);

            // Outer glow burst
            applyGlow(ctx, p.color, 25);
            ctx.fillStyle = `rgba(${hexToRgb(p.color)}, 0.3)`;
            ctx.beginPath();
            ctx.arc(px, py, 12, 0, Math.PI * 2);
            ctx.fill();

            // Bright white core
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(px, py, 6, 0, Math.PI * 2);
            ctx.fill();
            clearGlow(ctx);

            // Color ring
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(px, py, 9, 0, Math.PI * 2);
            ctx.stroke();

            // Long bright trail
            for (let i = 1; i <= 12; i++) {
                const trailT = Math.max(0, p.t - i * 0.012);
                const tx = lerp(a.x, b.x, trailT);
                const ty = lerp(a.y, b.y, trailT);
                const trailAlpha = 0.6 - i * 0.045;
                if (trailAlpha <= 0) break;
                ctx.fillStyle = `rgba(${hexToRgb(p.color)}, ${trailAlpha})`;
                ctx.beginPath();
                ctx.arc(tx, ty, 5 - i * 0.35, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Draw nodes
        for (const node of state.nodes.values()) {
            const pulse = Math.sin(elapsed / 800 + node.pulsePhase) * 0.5 + 0.5;
            const activityPulse = node.activity * pulse * 4;
            const r = node.baseRadius + activityPulse;
            node.radius = r;

            // Outer ring scan effect (rotating arc)
            const scanAngle = (elapsed / 1000 + node.pulsePhase) % (Math.PI * 2);
            ctx.strokeStyle = `rgba(${hexToRgb(node.color)}, ${0.15 + node.activity * 0.2})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 8 + pulse * 3, scanAngle, scanAngle + Math.PI * 0.7);
            ctx.stroke();

            // Second scan ring (counter-rotating)
            ctx.strokeStyle = `rgba(${hexToRgb(node.color)}, ${0.08 + node.activity * 0.1})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 14 + pulse * 2, -scanAngle * 0.7, -scanAngle * 0.7 + Math.PI * 0.4);
            ctx.stroke();

            // Glow halo
            const glowSize = 6 + node.activity * 12;
            applyGlow(ctx, node.color, glowSize);

            if (node.isActive) {
                // Solid fill for active agents
                ctx.fillStyle = node.color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.fill();

                // Inner bright core
                ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + pulse * 0.3})`;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r * 0.4, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Hollow ring for inactive
                ctx.strokeStyle = node.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.stroke();

                // Dim fill
                ctx.fillStyle = `rgba(${hexToRgb(node.color)}, 0.1)`;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.fill();

                // Crosshair marks
                ctx.strokeStyle = `rgba(${hexToRgb(node.color)}, 0.2)`;
                ctx.lineWidth = 0.5;
                const ch = r + 4;
                ctx.beginPath();
                ctx.moveTo(node.x - ch, node.y);
                ctx.lineTo(node.x - r + 2, node.y);
                ctx.moveTo(node.x + r - 2, node.y);
                ctx.lineTo(node.x + ch, node.y);
                ctx.moveTo(node.x, node.y - ch);
                ctx.lineTo(node.x, node.y - r + 2);
                ctx.moveTo(node.x, node.y + r - 2);
                ctx.lineTo(node.x, node.y + ch);
                ctx.stroke();
            }

            clearGlow(ctx);

            // Label with role subtitle
            ctx.font = "10px 'JetBrains Mono', monospace";
            ctx.fillStyle = `rgba(${hexToRgb(node.color)}, ${0.6 + node.activity * 0.4})`;
            ctx.textAlign = "center";
            ctx.fillText(node.label, node.x, node.y + r + 14);

            // Role tag
            const info = AgentColorTable[node.id];
            if (info) {
                ctx.font = "7px 'JetBrains Mono', monospace";
                ctx.fillStyle = `rgba(${hexToRgb(node.color)}, 0.3)`;
                ctx.fillText(info.role, node.x, node.y + r + 23);
            }
            ctx.textAlign = "left";

            // Status indicator
            if (node.isActive) {
                ctx.fillStyle = "#00ff41";
                ctx.beginPath();
                ctx.arc(node.x + r + 3, node.y - r + 3, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // HUD overlay text
        ctx.font = "8px 'JetBrains Mono', monospace";
        ctx.fillStyle = "#2a2a2a";
        ctx.fillText(
            `CREW TOPOLOGY  //  ${state.nodes.size} AGENTS  ${state.edges.length} LINKS  ${state.particles.length} ACTIVE`,
            8,
            14
        );
        const activeCount = Array.from(state.nodes.values()).filter((n) => n.isActive).length;
        ctx.fillText(`ONLINE: ${activeCount}/${state.nodes.size}  UPTIME: ${Math.floor(elapsed / 1000)}s`, 8, 24);
        ctx.fillStyle = "#1a1a1a";
        ctx.fillText(`RELAY PROTOCOL v2  //  HOPPER MESH NETWORK`, 8, height - 8);
    };
}

// --- Helpers ---

function hexToRgb(hex: string): string {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return "255, 255, 255";
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}

// --- ViewModel ---

class NodeGraphViewModel implements ViewModel {
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
        this.viewType = "nodegraph";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("diagram-project");
        this.viewName = jotai.atom("Nodes");
        this.viewComponent = NodeGraphView;
        this.noPadding = jotai.atom(true);
    }
}

// --- View Component ---

const NodeGraphView: React.FC<ViewComponentProps<NodeGraphViewModel>> = React.memo(({ model }) => {
    const { canvasRef, containerRef, width, height } = useCanvasSetup();
    const stateRef = React.useRef(new GraphState());

    // Subscribe to data sources
    React.useEffect(() => {
        const unsub1 = subscribeFleet();
        const unsub2 = subscribeInbox();
        return () => {
            unsub1();
            unsub2();
        };
    }, []);

    // Poll tmux for active sessions (local or remote)
    React.useEffect(() => {
        const checkTmux = async () => {
            try {
                const remote = getRemoteConfig();
                const tmux = getTmuxCmd();
                const cmd = remote?.remoteHost
                    ? `ssh ${remote.remoteHost} "${tmux} list-sessions -F '#{session_name}' 2>/dev/null"`
                    : `${tmux} list-sessions -F '#{session_name}' 2>/dev/null`;
                const result = await getApi().execCommand(cmd);
                const sessions = new Set(
                    (result.stdout || "")
                        .trim()
                        .split("\n")
                        .filter(Boolean)
                        .map((s) => s.toLowerCase())
                );
                for (const [name, node] of stateRef.current.nodes) {
                    node.isActive = sessions.has(name);
                }
            } catch {
                // silent
            }
        };
        checkTmux();
        const interval = setInterval(checkTmux, 30000);
        return () => clearInterval(interval);
    }, []);

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
NodeGraphView.displayName = "NodeGraphView";

export { NodeGraphViewModel };
