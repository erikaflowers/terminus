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

/** Move a block to `dstTabId`, or to a new tab in this window when dstTabId is null. Follows it there. */
export async function sendBlockToTab(blockId: string, dstTabId: string | null) {
    const srcTabId = globalStore.get(atoms.staticTabId);
    const wasOnlyBlock = isOnlyBlockInTab(srcTabId, blockId);
    const newTabId = await services.WorkspaceService.MoveBlockToTab(srcTabId, blockId, dstTabId ?? "");
    setActiveTab(newTabId);
    await closeTabIfEmptied(srcTabId, wasOnlyBlock);
}

/** Move a block into a brand-new Terminus window. */
export async function sendBlockToNewWindow(blockId: string) {
    const srcTabId = globalStore.get(atoms.staticTabId);
    const wasOnlyBlock = isOnlyBlockInTab(srcTabId, blockId);
    await services.WindowService.MoveBlockToNewWindow(srcTabId, blockId);
    await closeTabIfEmptied(srcTabId, wasOnlyBlock);
}

/** "Send to Tab ▸ [other tabs…, New Tab]" and "Send to New Window" for a pane's context menu. */
export function getSendBlockMenuItems(blockId: string): ContextMenuItem[] {
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
    return [
        { label: "Send to Tab", type: "submenu", submenu: tabItems },
        { label: "Send to New Window", click: () => fireAndForget(() => sendBlockToNewWindow(blockId)) },
    ];
}
