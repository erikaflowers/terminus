// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Clone Workspace, receiving side. Another machine drops a snapshot into
// <data dir>/workspace-inbox/ over ssh (written as .tmp, then renamed). We hand each snapshot to the
// focused window, which asks whether to open it; the renderer reports back and the file is removed.
// Files that arrived while Terminus was closed are offered at startup.

import { ipcMain } from "electron";
import fs from "fs";
import path from "path";
import { getWaveDataDir } from "./emain-platform";
import { focusedWaveWindow, getAllWaveWindows } from "./emain-window";

const inFlight = new Set<string>();

function inboxDir(): string {
    return path.join(getWaveDataDir(), "workspace-inbox");
}

function deliver(file: string) {
    if (inFlight.has(file) || !file.endsWith(".json")) {
        return;
    }
    const full = path.join(inboxDir(), file);
    let snapshot: any;
    try {
        const text = fs.readFileSync(full, "utf8");
        if (text.length > 2 * 1024 * 1024) {
            throw new Error("snapshot too large");
        }
        snapshot = JSON.parse(text);
        if (snapshot?.type !== "terminus-workspace") {
            throw new Error("not a terminus workspace snapshot");
        }
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            return;
        }
        console.log("workspace-inbox: discarding", file, String(e));
        fs.rmSync(full, { force: true });
        return;
    }
    const ww = focusedWaveWindow ?? getAllWaveWindows()[0];
    const wc = ww?.activeTabView?.webContents;
    if (wc == null) {
        return; // no window yet; picked up by the next scan
    }
    inFlight.add(file);
    if (ww.isMinimized()) {
        ww.restore();
    }
    ww.focus();
    wc.send("workspace-snapshot", { file, snapshot });
}

function scan() {
    let files: string[] = [];
    try {
        files = fs.readdirSync(inboxDir());
    } catch {
        return;
    }
    for (const f of files.sort()) {
        deliver(f);
    }
}

export function startWorkspaceInbox() {
    try {
        fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
        fs.watch(inboxDir(), () => scan());
    } catch (e) {
        console.log("workspace-inbox: unable to watch", String(e));
        return;
    }
    scan();
}

ipcMain.on("workspace-snapshot-done", (_event, file: string, accepted: boolean) => {
    if (typeof file !== "string" || file.includes("/") || file.includes("\\") || !file.endsWith(".json")) {
        return;
    }
    console.log("workspace-inbox:", accepted ? "opened" : "declined", file);
    fs.rmSync(path.join(inboxDir(), file), { force: true });
    inFlight.delete(file);
});
