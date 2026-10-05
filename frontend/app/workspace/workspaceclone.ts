// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Clone Workspace: send this window's tabs, splits and pane settings to another of your machines
// (over ssh, into Terminus's workspace-inbox there) or through the clipboard. The machine that opens
// it rebuilds the same layout in a new window; remembered ssh+tmux sessions reconnect by themselves.

import { atoms, getApi, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import * as services from "@/app/store/services";
import { shellQuote, sshCommand } from "@/util/shellquote";
import { stringToBase64 } from "@/util/util";
import {
    adaptPaneMetaForHere,
    collectLeafBlockIds,
    hostLabel,
    parseTailscaleStatus,
    portablePaneMeta,
    sshTargetFor,
    TailnetMachine,
    toSnapshotTree,
    WorkspaceSnapshot,
    WorkspaceSnapshotType,
} from "./workspaceclone-util";

const TailscaleCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const InboxRelDir = "Library/Application Support/terminus/workspace-inbox";

async function tailscaleStatus(): Promise<{ self: TailnetMachine; peers: TailnetMachine[] } | null> {
    try {
        const result = await getApi().execCommand(`${shellQuote(TailscaleCli)} status --json`);
        return result.code === 0 ? parseTailscaleStatus(result.stdout) : null;
    } catch {
        return null;
    }
}

/** Names this machine goes by (hostname, tailnet name), lowercase first labels. */
async function localMachineNames(): Promise<Set<string>> {
    const names = new Set<string>([hostLabel(getApi().getHostName())]);
    const ts = await tailscaleStatus();
    if (ts?.self) {
        names.add(ts.self.label);
        names.add(hostLabel(ts.self.hostName));
    }
    names.delete("");
    return names;
}

function findLeafBlockId(node: any, nodeId: string): string {
    if (node?.id === nodeId) {
        return node?.data?.blockId;
    }
    for (const c of node?.children ?? []) {
        const found = findLeafBlockId(c, nodeId);
        if (found) return found;
    }
    return null;
}

export async function buildWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
    const ws = globalStore.get(atoms.workspace);
    const tabs = [];
    for (const tabId of ws?.tabids ?? []) {
        const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
        const layout = await WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", tab?.layoutstate));
        const blockIds = collectLeafBlockIds(layout?.rootnode);
        if (blockIds.length === 0) {
            continue;
        }
        const blocks = await Promise.all(
            blockIds.map(async (id) => {
                const block = await WOS.reloadWaveObject<Block>(WOS.makeORef("block", id));
                return { meta: portablePaneMeta(block?.meta ?? {}) };
            })
        );
        const focusedBlockId = findLeafBlockId(layout.rootnode, layout.focusednodeid);
        tabs.push({
            name: tab?.name ?? "",
            rootnode: toSnapshotTree(layout.rootnode, blockIds),
            blocks,
            focusedblockindex: Math.max(0, blockIds.indexOf(focusedBlockId)),
        });
    }
    const ts = await tailscaleStatus();
    return {
        type: WorkspaceSnapshotType,
        version: 1,
        from: ts?.self?.label || hostLabel(getApi().getHostName()),
        createdat: Date.now(),
        tabs,
    };
}

/** Your other machines that are online (macOS), with the ssh destination to reach each. */
export async function listCloneTargets(): Promise<{ label: string; target: string }[]> {
    const ts = await tailscaleStatus();
    if (!ts) {
        return [];
    }
    const snapshotHosts: string[] = [];
    for (const tabId of globalStore.get(atoms.workspace)?.tabids ?? []) {
        const tab = WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabId));
        for (const blockId of tab?.blockids ?? []) {
            const host = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta?.["session:host"];
            if (host) snapshotHosts.push(host);
        }
    }
    return ts.peers
        .filter((p) => p.online && p.os === "macos" && p.label !== ts.self.label)
        .map((p) => ({ label: p.label, target: sshTargetFor(p, snapshotHosts) }));
}

export async function sendWorkspaceTo(target: string): Promise<void> {
    const snap = await buildWorkspaceSnapshot();
    if (snap.tabs.length === 0) {
        throw new Error("nothing to send");
    }
    const file = `${Date.now()}-${snap.from || "terminus"}.json`;
    const remote = [
        "sh",
        "-c",
        'd="$HOME/$1"; mkdir -p "$d" && cat > "$d/$2.tmp" && mv "$d/$2.tmp" "$d/$2"',
        "sh",
        InboxRelDir,
        file,
    ];
    const b64 = stringToBase64(JSON.stringify(snap));
    const cmd =
        `printf '%s' ${shellQuote(b64)} | base64 -d | ` +
        sshCommand(target, remote, { sshOpts: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] });
    const result = await getApi().execCommand(cmd);
    if (result.code !== 0) {
        throw new Error((result.stderr || "ssh failed").trim());
    }
}

export async function copyWorkspaceSnapshot(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(await buildWorkspaceSnapshot()));
}

export async function readWorkspaceSnapshotFromClipboard(): Promise<WorkspaceSnapshot | null> {
    try {
        const snap = JSON.parse(await navigator.clipboard.readText());
        return snap?.type === WorkspaceSnapshotType ? snap : null;
    } catch {
        return null;
    }
}

/** Open a snapshot here, as a new window, with sessions adapted to this machine. */
export async function openWorkspaceSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    const local = await localMachineNames();
    // ssh destination for the sender's own ("local") sessions: reuse a user@ seen for that machine
    const knownHosts = snap.tabs.flatMap((t) => t.blocks.map((b) => b.meta?.["session:host"]).filter(Boolean));
    const sender = snap.from ? sshTargetFor({ label: snap.from, hostName: snap.from, os: "", online: true }, knownHosts) : null;
    const adapted = {
        ...snap,
        tabs: snap.tabs.map((t) => ({
            ...t,
            blocks: t.blocks.map((b) => ({ meta: adaptPaneMetaForHere(b.meta ?? {}, local, sender) })),
        })),
    };
    await services.WindowService.OpenWorkspaceSnapshot(JSON.stringify(adapted));
}

export function promptOpenWorkspaceSnapshot(snapshot: WorkspaceSnapshot, file?: string) {
    modalsModel.pushModal("WorkspaceSnapshotModal", { snapshot, file });
}

export function showMessage(text: string) {
    modalsModel.pushModal("MessageModal", { children: text });
}
