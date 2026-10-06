// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for Clone Workspace: turn a tab's layout tree into a portable snapshot tree, adapt
// pane settings for the machine that opens it, and work out which of your machines to send to.

import { LocalHost, parseLegacyInitScript } from "@/app/block/sessionrestore-util";
import { isSafeSessionName } from "@/util/shellquote";

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

/**
 * Pane settings worth carrying to another machine. An old auto-reconnect init script is never
 * carried: it becomes a remembered session (the receiving pane offers it instead of running it).
 */
export function portablePaneMeta(meta: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    const legacy = parseLegacyInitScript(meta?.["cmd:initscript.zsh"]);
    const hasSession = !!(meta?.["session:host"] && meta?.["session:tmux"]) || !!legacy;
    for (const [k, v] of Object.entries(meta ?? {})) {
        if (hasSession && k.startsWith("cmd:initscript")) continue;
        out[k] = v;
    }
    if (legacy && !(meta?.["session:host"] && meta?.["session:tmux"])) {
        out["session:host"] = legacy.host;
        out["session:tmux"] = legacy.session;
    }
    return out;
}

/** "user@host.domain" → "host" (lowercase), for comparing machines. */
export function hostLabel(host: string): string {
    return (host ?? "").split("@").pop().split(".")[0].toLowerCase();
}

/**
 * Adapt a pane for the machine opening the snapshot. Panes never connect on their own: a remembered
 * session arrives as a memory (the pane offers it), with its host rewritten to "local" when the
 * session lives on the receiving machine, or from "local" to the sender when it doesn't.
 */
export function adaptPaneMetaForHere(
    meta: Record<string, any>,
    localNames: Set<string>,
    senderHost?: string
): Record<string, any> {
    const host = meta?.["session:host"];
    const session = meta?.["session:tmux"];
    if (!host || !session || !isSafeSessionName(session)) {
        return meta;
    }
    if (host === LocalHost) {
        return senderHost && !localNames.has(hostLabel(senderHost)) ? { ...meta, "session:host": senderHost } : meta;
    }
    return localNames.has(hostLabel(host)) ? { ...meta, "session:host": LocalHost } : meta;
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
