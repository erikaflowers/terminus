// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Session Restore: a pane remembers "ssh <host> → tmux <session>" and comes back to it on its own
// after Terminus restarts. Remembering stores the target in block meta (session:host/session:tmux)
// and sets the pane's init script to an attach-or-create command, so every fresh shell in that pane
// (app launch, restart, Enter after a dropped connection) reconnects. Nothing is typed into a live
// shell and a connected pane is left alone until its next start.

import { getApi, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atoms } from "@/store/global";
import * as jotai from "jotai";
import {
    buildListSessionsCommand,
    buildSessionRestoreScript,
    parseSessionList,
    parseSshCommand,
    SshTarget,
} from "./sessionrestore-util";

// Last ssh command seen running in each pane (from shell integration), keyed by block id
const detectedSshAtoms = new Map<string, jotai.PrimitiveAtom<SshTarget | null>>();

export function getDetectedSshAtom(blockId: string): jotai.PrimitiveAtom<SshTarget | null> {
    let a = detectedSshAtoms.get(blockId);
    if (a == null) {
        a = jotai.atom(null) as jotai.PrimitiveAtom<SshTarget | null>;
        detectedSshAtoms.set(blockId, a);
    }
    return a;
}

/** Called for every command the pane's shell starts (typed line, and the alias-expanded line if different). */
export function noteShellCommand(blockId: string, typed: string, expanded?: string) {
    const target = parseSshCommand(expanded || typed) ?? parseSshCommand(typed);
    if (target != null) {
        globalStore.set(getDetectedSshAtom(blockId), target);
    }
}

export async function rememberSession(blockId: string, host: string, session: string): Promise<boolean> {
    const script = buildSessionRestoreScript(host, session);
    if (script == null) {
        return false;
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: { "session:host": host, "session:tmux": session, "cmd:initscript.zsh": script },
    });
    return true;
}

export async function forgetSession(blockId: string) {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: { "session:host": null, "session:tmux": null, "cmd:initscript.zsh": null },
    });
}

/** Restart the pane's shell now, which runs the remembered connect command. */
export async function reconnectSession(blockId: string) {
    await RpcApi.ControllerResyncCommand(TabRpcClient, {
        tabid: globalStore.get(atoms.staticTabId),
        blockid: blockId,
        forcerestart: true,
    });
}

export async function listRemoteSessions(host: string): Promise<{ name: string; attached: number }[] | null> {
    try {
        const result = await getApi().execCommand(buildListSessionsCommand(host));
        if (result.code !== 0 && !result.stdout) {
            return null;
        }
        return parseSessionList(result.stdout);
    } catch {
        return null;
    }
}
