// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for Clone Workspace: turn a tab's layout tree into a portable snapshot tree, adapt
// pane settings for the machine that opens it, and work out which of your machines to send to.

import { buildSessionRestoreScript } from "@/app/block/sessionrestore-util";
import { isSafeSessionName, shellJoin } from "@/util/shellquote";

export const WorkspaceSnapshotType = "terminus-workspace";

export type SnapshotTab = {
    name: string;
    rootnode: any; // layout tree; leaves have data.blockindex instead of data.blockId
    blocks: { meta: Record<string, any> }[];
    focusedblockindex: number;
};

export type WorkspaceSnapshot = {
    type: typeof WorkspaceSnapshotType;
    version: 1;
    from: string;
    createdat: number;
    tabs: SnapshotTab[];
};

/** Copy a layout tree without node ids; leaves point at an index in `blockIds` (unknown blocks are dropped). */
export function toSnapshotTree(node: any, blockIds: string[]): any {
    if (node == null) {
        return null;
    }
    const out: any = {};
    if (node.flexDirection) out.flexDirection = node.flexDirection;
    if (typeof node.size === "number") out.size = node.size;
    if (node.data?.blockId) {
        const idx = blockIds.indexOf(node.data.blockId);
        if (idx < 0) return null;
        out.data = { blockindex: idx };
        return out;
    }
    const children = (node.children ?? []).map((c: any) => toSnapshotTree(c, blockIds)).filter((c: any) => c != null);
    if (children.length === 0) {
        return null;
    }
    out.children = children;
    return out;
}

/** Leaf block ids in tree order. */
export function collectLeafBlockIds(node: any, acc: string[] = []): string[] {
    if (node?.data?.blockId) {
        acc.push(node.data.blockId);
    }
    for (const c of node?.children ?? []) {
        collectLeafBlockIds(c, acc);
    }
    return acc;
}

/** Pane settings worth carrying to another machine (init scripts are rebuilt on arrival for remembered sessions). */
export function portablePaneMeta(meta: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    const hasSession = !!(meta?.["session:host"] && meta?.["session:tmux"]);
    for (const [k, v] of Object.entries(meta ?? {})) {
        if (hasSession && k.startsWith("cmd:initscript")) continue;
        out[k] = v;
    }
    return out;
}

/** "user@host.domain" → "host" (lowercase), for comparing machines. */
export function hostLabel(host: string): string {
    return (host ?? "").split("@").pop().split(".")[0].toLowerCase();
}

/**
 * Adapt a pane for the machine opening the snapshot: a remembered ssh+tmux session reconnects
 * (ssh), unless its host IS this machine, in which case it attaches to tmux locally.
 */
export function adaptPaneMetaForHere(meta: Record<string, any>, localNames: Set<string>): Record<string, any> {
    const host = meta?.["session:host"];
    const session = meta?.["session:tmux"];
    if (!host || !session || !isSafeSessionName(session)) {
        return meta;
    }
    const script = localNames.has(hostLabel(host))
        ? `exec ${shellJoin(["tmux", "new-session", "-A", "-s", session])}\n`
        : buildSessionRestoreScript(host, session);
    return script ? { ...meta, "cmd:initscript.zsh": script } : meta;
}

export type TailnetMachine = { label: string; hostName: string; os: string; online: boolean };

/** Machines from `tailscale status --json` (self first), labels are the tailnet names (e.g. mac-studio-2). */
export function parseTailscaleStatus(json: string): { self: TailnetMachine; peers: TailnetMachine[] } {
    const st = JSON.parse(json);
    const toMachine = (p: any): TailnetMachine => ({
        label: hostLabel(p?.DNSName || p?.HostName || ""),
        hostName: (p?.HostName ?? "").toLowerCase(),
        os: (p?.OS ?? "").toLowerCase(),
        online: !!p?.Online,
    });
    const peers = Object.values(st?.Peer ?? {})
        .map(toMachine)
        .filter((m) => m.label);
    return { self: toMachine(st?.Self), peers };
}

/** ssh destination for a machine: reuse the user@ from a remembered session on that machine if any. */
export function sshTargetFor(machine: TailnetMachine, knownHosts: string[]): string {
    for (const h of knownHosts) {
        if (h.includes("@") && hostLabel(h) === machine.label) {
            return h.split("@")[0] + "@" + machine.label;
        }
    }
    return machine.label;
}
