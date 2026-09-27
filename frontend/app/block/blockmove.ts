// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Send a pane (block) to another tab or to a new window. The block keeps its id, so its process
// (shell, ssh, tmux…) keeps running on the backend: this is a real move, nothing reconnects.

import { atoms, getApi, setActiveTab, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as services from "@/app/store/services";
import { deleteLayoutModelForTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";

function getTab(tabId: string): Tab {
    return globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
}

function isOnlyBlockInTab(tabId: string, blockId: string): boolean {
    const blockIds = getTab(tabId)?.blockids ?? [];
    return blockIds.length === 1 && blockIds[0] === blockId;
}

// A tab whose last pane was sent away closes, the same as closing its last pane
// (if it was the window's last tab, the window closes too).
async function closeTabIfEmptied(srcTabId: string, wasOnlyBlock: boolean) {
    if (!wasOnlyBlock) {
        return;
    }
    const ws = globalStore.get(atoms.workspace);
    const didClose = await getApi().closeTab(ws.oid, srcTabId, false);
    if (didClose) {
        deleteLayoutModelForTab(srcTabId);
    }
}

/**
 * Move a block to `dstTabId` (a tab in this or any other window), or to a new tab in `dstWorkspaceId`
 * (this window's workspace when omitted). Same-window moves follow the pane here; for another window the
 * backend switches that window to the tab and brings it forward.
 */
export async function sendBlockToTab(blockId: string, dstTabId: string | null, dstWorkspaceId?: string) {
    const srcTabId = globalStore.get(atoms.staticTabId);
    const ws = globalStore.get(atoms.workspace);
    const wasOnlyBlock = isOnlyBlockInTab(srcTabId, blockId);
    const newTabId = await services.WorkspaceService.MoveBlockToTab(
        srcTabId,
        blockId,
        dstTabId ?? "",
        dstWorkspaceId ?? ""
    );
    const sameWindow = (dstWorkspaceId ?? ws.oid) === ws.oid && (dstTabId == null || ws.tabids.includes(dstTabId));
    if (sameWindow) {
        setActiveTab(newTabId);
    }
    await closeTabIfEmptied(srcTabId, wasOnlyBlock);
}

/** Move a block into a brand-new Terminus window. */
export async function sendBlockToNewWindow(blockId: string) {
    const srcTabId = globalStore.get(atoms.staticTabId);
    const wasOnlyBlock = isOnlyBlockInTab(srcTabId, blockId);
    await services.WindowService.MoveBlockToNewWindow(srcTabId, blockId);
    await closeTabIfEmptied(srcTabId, wasOnlyBlock);
}

type OtherWindow = { workspaceId: string; label: string; tabs: { id: string; name: string }[] };

// Other open windows and their tabs (their objects may not be loaded in this window yet).
async function loadOtherWindows(): Promise<OtherWindow[]> {
    const myWsId = globalStore.get(atoms.workspace)?.oid;
    const entries = (await services.WorkspaceService.ListWorkspaces()) ?? [];
    const rtn: OtherWindow[] = [];
    for (const entry of entries) {
        if (!entry.windowid || entry.workspaceid === myWsId) {
            continue;
        }
        try {
            const ws = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", entry.workspaceid));
            const tabs = await Promise.all(
                (ws?.tabids ?? []).map(async (id) => {
                    const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", id));
                    return { id, name: tab?.name || "Untitled Tab" };
                })
            );
            const tabNames = tabs.map((t) => t.name).join(", ");
            const label = ws?.name || (tabNames.length > 40 ? tabNames.slice(0, 39) + "…" : tabNames) || "Window";
            rtn.push({ workspaceId: entry.workspaceid, label, tabs });
        } catch (e) {
            console.log("send to window: couldn't load workspace", entry.workspaceid, e);
        }
    }
    return rtn;
}

/**
 * Context-menu items: "Send to Tab ▸ [this window's tabs…, New Tab]", "Send to Window ▸ [each other
 * window ▸ its tabs…, New Tab]" (when other windows are open), and "Send to New Window".
 */
export async function getSendBlockMenuItems(blockId: string): Promise<ContextMenuItem[]> {
    const srcTabId = globalStore.get(atoms.staticTabId);
    const ws = globalStore.get(atoms.workspace);
    const tabItems: ContextMenuItem[] = [];
    for (const tabId of ws?.tabids ?? []) {
        if (tabId === srcTabId) {
            continue;
        }
        tabItems.push({
            label: getTab(tabId)?.name || "Untitled Tab",
            click: () => fireAndForget(() => sendBlockToTab(blockId, tabId)),
        });
    }
    if (tabItems.length > 0) {
        tabItems.push({ type: "separator" });
    }
    tabItems.push({ label: "New Tab", click: () => fireAndForget(() => sendBlockToTab(blockId, null)) });
    const items: ContextMenuItem[] = [{ label: "Send to Tab", type: "submenu", submenu: tabItems }];

    let otherWindows: OtherWindow[] = [];
    try {
        otherWindows = await loadOtherWindows();
    } catch (e) {
        console.log("send to window: couldn't list windows", e);
    }
    if (otherWindows.length > 0) {
        items.push({
            label: "Send to Window",
            type: "submenu",
            submenu: otherWindows.map((w) => ({
                label: w.label,
                type: "submenu",
                submenu: [
                    ...w.tabs.map((t) => ({
                        label: t.name,
                        click: () => fireAndForget(() => sendBlockToTab(blockId, t.id, w.workspaceId)),
                    })),
                    { type: "separator" },
                    {
                        label: "New Tab",
                        click: () => fireAndForget(() => sendBlockToTab(blockId, null, w.workspaceId)),
                    },
                ] as ContextMenuItem[],
            })),
        });
    }
    items.push({ label: "Send to New Window", click: () => fireAndForget(() => sendBlockToNewWindow(blockId)) });
    return items;
}
