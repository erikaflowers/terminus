// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Home sessions: the Mini (Crew's remote host) holds the tmux sessions, and panes are windows onto
// it. A pane NEVER connects on its own. It remembers the last session it showed (block meta
// session:host / session:tmux), and while it isn't attached a bar offers Attach / Pick / dismiss.
// Attaching types an attach-only command at the pane's prompt (no exec, never creates a session),
// so detaching or a dropped connection lands back in the pane's own shell.
//
// Older builds wrote an auto-reconnect init script (`exec … tmux new-session -A`); migrateLegacyPane
// turns those into a remembered session before the pane's shell first starts.

import { getRemoteConfig } from "@/app/store/agents";
import { getApi, getBlockComponentModel, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isSafeSessionName, shellJoin, sshCommand } from "@/util/shellquote";
import { stringToBase64 } from "@/util/util";
import type { ShellIntegrationStatus } from "@/app/view/term/osc-handlers";
import * as jotai from "jotai";
import {
    buildAttachCommand,
    buildListSessionsCommand,
    LocalHost,
    parseLegacyInitScript,
    parseLocalTmuxAttach,
    parseSessionList,
    parseSshCommand,
    SshTarget,
} from "./sessionrestore-util";

export type SessionTarget = { host: string; session: string };
export type RemoteSession = { name: string; attached: number };

function blockAtom<T>(map: Map<string, jotai.PrimitiveAtom<T>>, blockId: string, init: T): jotai.PrimitiveAtom<T> {
    let a = map.get(blockId);
    if (a == null) {
        a = jotai.atom(init) as jotai.PrimitiveAtom<T>;
        map.set(blockId, a);
    }
    return a;
}

// Last ssh command seen running in each pane (from shell integration)
const detectedSshAtoms = new Map<string, jotai.PrimitiveAtom<SshTarget | null>>();
// The session a pane is attached to right now (null at its own prompt)
const attachedAtoms = new Map<string, jotai.PrimitiveAtom<SessionTarget | null>>();
// Why the last attach didn't stick ("lee isn't running on julians-mac-mini"), shown on the bar
const attachErrorAtoms = new Map<string, jotai.PrimitiveAtom<string | null>>();
// An attach we just typed: the next command start is it
const pendingAttach = new Map<string, SessionTarget & { at: number }>();
// When each pane's current command started (to tell "attach failed" from "detached after an hour")
const commandStartedAt = new Map<string, number>();

export function getDetectedSshAtom(blockId: string) {
    return blockAtom(detectedSshAtoms, blockId, null as SshTarget | null);
}
export function getAttachedAtom(blockId: string) {
    return blockAtom(attachedAtoms, blockId, null as SessionTarget | null);
}
export function getAttachErrorAtom(blockId: string) {
    return blockAtom(attachErrorAtoms, blockId, null as string | null);
}

/** "juliansiddig@julians-mac-mini.taila3dc77.ts.net" → "julians-mac-mini"; "local" → "this Mac". */
export function hostDisplayName(host: string): string {
    if (!host || host === LocalHost) {
        return "this Mac";
    }
    return host.split("@").pop().split(".")[0];
}

/** Where the sessions live: Crew's remote host, else this machine. */
export function getHomeHost(): string {
    return getRemoteConfig()?.remoteHost || LocalHost;
}

/** Called for every command the pane's shell starts (typed line, and the alias-expanded line if different). */
export function noteShellCommand(blockId: string, typed: string, expanded?: string) {
    commandStartedAt.set(blockId, Date.now());
    const ssh = parseSshCommand(expanded || typed) ?? parseSshCommand(typed);
    if (ssh != null) {
        globalStore.set(getDetectedSshAtom(blockId), ssh);
    }
    const pending = pendingAttach.get(blockId);
    let target: SessionTarget = null;
    if (pending && Date.now() - pending.at < 15000) {
        target = { host: pending.host, session: pending.session };
    } else if (ssh?.tmuxSession) {
        target = { host: ssh.host, session: ssh.tmuxSession };
    } else {
        const local = parseLocalTmuxAttach(expanded || typed) ?? parseLocalTmuxAttach(typed);
        if (local) {
            target = { host: LocalHost, session: local };
        }
    }
    pendingAttach.delete(blockId);
    if (target) {
        globalStore.set(getAttachedAtom(blockId), target);
        globalStore.set(getAttachErrorAtom(blockId), null);
        void rememberSession(blockId, target);
    }
}

/** The command finished: if it was an attach that failed fast, say why on the bar. */
export function noteCommandDone(blockId: string, exitCode: number | null) {
    const attached = globalStore.get(getAttachedAtom(blockId));
    const startedAt = commandStartedAt.get(blockId);
    if (attached && exitCode != null && exitCode !== 0 && startedAt && Date.now() - startedAt < 5000) {
        globalStore.set(
            getAttachErrorAtom(blockId),
            `${attached.session} isn't running on ${hostDisplayName(attached.host)} (or ssh failed).`
        );
    }
}

/** The pane's shell drew its prompt: whatever was attached has detached. */
export function notePrompt(blockId: string) {
    if (globalStore.get(getAttachedAtom(blockId)) != null) {
        globalStore.set(getAttachedAtom(blockId), null);
    }
}

async function rememberSession(blockId: string, target: SessionTarget) {
    const meta = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta;
    if (meta?.["session:host"] === target.host && meta?.["session:tmux"] === target.session && !meta?.["session:off"]) {
        return;
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: { "session:host": target.host, "session:tmux": target.session, "session:off": null },
    });
}

/** Dismiss (×): the pane forgets its session and stops offering one. The header button still picks. */
export async function forgetSession(blockId: string) {
    globalStore.set(getAttachErrorAtom(blockId), null);
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: { "session:host": null, "session:tmux": null, "session:off": true },
    });
}

function shellStatusAtom(blockId: string): jotai.Atom<ShellIntegrationStatus | null> | null {
    const vm = getBlockComponentModel(blockId)?.viewModel as any;
    return vm?.termRef?.current?.shellIntegrationStatusAtom ?? null;
}

/** Before force-restarting a pane's shell: forget the old shell's state so the next attach waits for the new prompt. */
export function resetPaneState(blockId: string) {
    pendingAttach.delete(blockId);
    globalStore.set(getAttachedAtom(blockId), null);
    globalStore.set(getAttachErrorAtom(blockId), null);
    const a = shellStatusAtom(blockId);
    if (a) {
        globalStore.set(a as jotai.PrimitiveAtom<ShellIntegrationStatus | null>, null);
    }
}

/**
 * Is it safe to type at this pane? Waits briefly for its prompt. Refuses only when a command is
 * visibly running; without shell integration (e.g. Terminus started inside tmux) the state is
 * unknown, and typing into a shell that's still starting is fine (the tty buffers it).
 */
async function waitForPrompt(blockId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let status: ShellIntegrationStatus | null = null;
    while (Date.now() < deadline) {
        const a = shellStatusAtom(blockId);
        status = a ? globalStore.get(a) : null;
        if (status === "ready") {
            return true;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    return status !== "running-command";
}

/**
 * Attach this pane to `session` on `host` by typing the attach command at its prompt. Returns null
 * on success, or why not (the pane is busy, bad name). Never creates a session.
 */
export async function attachPane(blockId: string, host: string, session: string): Promise<string | null> {
    const cmd = buildAttachCommand(host, session);
    if (cmd == null) {
        return "Invalid host or session name.";
    }
    if (globalStore.get(getAttachedAtom(blockId)) != null) {
        return "This pane is already attached. Detach first (Ctrl-b d).";
    }
    if (!(await waitForPrompt(blockId, 3000))) {
        return "This pane is busy. Finish what's running, then attach.";
    }
    await rememberSession(blockId, { host, session });
    globalStore.set(getAttachErrorAtom(blockId), null);
    pendingAttach.set(blockId, { host, session, at: Date.now() });
    await RpcApi.ControllerInputCommand(TabRpcClient, {
        blockid: blockId,
        inputdata64: stringToBase64(cmd + "\r"),
    });
    return null;
}

/** tmux sessions on `host` ("local" = this machine), or null if they couldn't be listed. */
export async function listSessions(host: string): Promise<RemoteSession[] | null> {
    const cmd =
        !host || host === LocalHost
            ? `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; ${shellJoin(["tmux", "ls", "-F", "#{session_name}|#{session_attached}"])} 2>/dev/null`
            : buildListSessionsCommand(host);
    try {
        const result = await getApi().execCommand(cmd);
        if (result.code !== 0 && !result.stdout) {
            // tmux ls exits 1 with no server running: that's "no sessions", not an error
            return host === LocalHost ? [] : null;
        }
        return parseSessionList(result.stdout);
    } catch {
        return null;
    }
}

const migrated = new Set<string>();

/**
 * Before a pane's shell first starts: if it carries an old auto-reconnect init script, drop it and
 * keep what it pointed at as the pane's remembered session. Idempotent; cheap when there's nothing to do.
 */
export async function migrateLegacyPane(blockId: string): Promise<void> {
    if (migrated.has(blockId)) {
        return;
    }
    migrated.add(blockId);
    const meta = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta;
    const legacy = parseLegacyInitScript(meta?.["cmd:initscript.zsh"]);
    if (legacy == null) {
        return;
    }
    const hasSession = !!(meta?.["session:host"] && meta?.["session:tmux"]);
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: {
            "cmd:initscript.zsh": null,
            ...(hasSession ? {} : { "session:host": legacy.host, "session:tmux": legacy.session }),
        },
    });
}

/**
 * Start an agent's session where the sessions live, the way `launch <agent>` does on the Mini:
 * a detached tmux session in that machine's agent folder running `clauded`. Returns null on
 * success, else why not. Does nothing if the session already exists.
 */
export async function launchAgentAtHome(host: string, agent: string): Promise<string | null> {
    if (!isSafeSessionName(agent)) {
        return "Invalid agent name.";
    }
    const script =
        `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; ` +
        `tmux has-session -t "=$1" 2>/dev/null && exit 0; ` +
        `d="$HOME/claude projects/Matilda/agent-$1"; [ -d "$d" ] || d="$HOME"; ` +
        `tmux new-session -d -s "$1" -c "$d" && tmux send-keys -t "=$1:" 'unset CLAUDECODE && clauded' Enter`;
    const args = ["sh", "-c", script, "sh", agent];
    const cmd =
        !host || host === LocalHost
            ? shellJoin(args)
            : sshCommand(host, args, { sshOpts: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] });
    try {
        const result = await getApi().execCommand(cmd);
        return result.code === 0 ? null : `Couldn't start ${agent} on ${hostDisplayName(host)}.`;
    } catch {
        return `Couldn't start ${agent} on ${hostDisplayName(host)}.`;
    }
}
