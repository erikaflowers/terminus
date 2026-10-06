// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for home sessions: recognise an ssh/tmux command line, build the attach command a
// pane runs when you pick a session, and read the old auto-reconnect init scripts (for migration).

import { isSafeSessionName, shellJoin, shellQuote, sshCommand } from "@/util/shellquote";

/** session:host value for a tmux session on this machine (no ssh). */
export const LocalHost = "local";

// ssh options that take a value (from ssh(1)); anything else starting with "-" is a flag
const SshOptsWithArg = new Set("BbcDEeFIiJLlmOoPpQRSWw".split("").map((c) => "-" + c));

// Appended to the remote PATH: non-interactive ssh on macOS doesn't include Homebrew
const RemotePath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/** Minimal shell-word split: whitespace, single/double quotes, backslash escapes. */
export function splitShellWords(line: string): string[] {
    const words: string[] = [];
    let cur = "";
    let inWord = false;
    let quote: string = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) {
                quote = null;
            } else if (c === "\\" && quote === '"' && i + 1 < line.length) {
                cur += line[++i];
            } else {
                cur += c;
            }
        } else if (c === "'" || c === '"') {
            quote = c;
            inWord = true;
        } else if (c === "\\" && i + 1 < line.length) {
            cur += line[++i];
            inWord = true;
        } else if (/\s/.test(c)) {
            if (inWord) {
                words.push(cur);
                cur = "";
                inWord = false;
            }
        } else if (";|&".includes(c)) {
            break; // only the first command of a pipeline/list matters
        } else {
            cur += c;
            inWord = true;
        }
    }
    if (inWord) {
        words.push(cur);
    }
    return words;
}

export type SshTarget = { host: string; tmuxSession?: string };

/**
 * If `cmdline` runs ssh, return its destination (as typed, e.g. "user@host") and, when the remote
 * command is a tmux attach/new, the session name. Returns null for anything else.
 */
export function parseSshCommand(cmdline: string): SshTarget | null {
    if (!cmdline) {
        return null;
    }
    let words = splitShellWords(cmdline.trim());
    while (
        words.length > 0 &&
        (words[0] === "exec" || words[0] === "command" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))
    ) {
        words = words.slice(1);
    }
    if (words.length === 0 || (words[0] !== "ssh" && !words[0].endsWith("/ssh"))) {
        return null;
    }
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) {
        const w = words[i];
        if (w === "--") {
            i++;
            break;
        }
        // "-p 22" takes the next word; "-p22" / "-oFoo=bar" carry their value inline
        i += SshOptsWithArg.has(w) ? 2 : 1;
    }
    if (i >= words.length) {
        return null;
    }
    const host = words[i];
    if (!/^[A-Za-z0-9_.@:%\[\]-]+$/.test(host)) {
        return null;
    }
    const target: SshTarget = { host };
    const remote = splitShellWords(words.slice(i + 1).join(" "));
    const t = remote.findIndex((w) => w === "tmux" || w.endsWith("/tmux"));
    if (t >= 0) {
        const rest = remote.slice(t + 1);
        const sub = rest[0];
        if (["attach", "attach-session", "a", "at", "new", "new-session"].includes(sub)) {
            const flag = sub.startsWith("new") ? "-s" : "-t";
            const k = rest.indexOf(flag);
            const name = k >= 0 ? rest[k + 1]?.replace(/^=/, "") : undefined;
            if (name && isSafeSessionName(name)) {
                target.tmuxSession = name;
            }
        }
    }
    return target;
}

/** A local `tmux attach -t <name>` typed in a pane (no ssh): the session name, or null. */
export function parseLocalTmuxAttach(cmdline: string): string | null {
    const words = splitShellWords((cmdline ?? "").trim()).filter((w) => w !== "exec" && w !== "command");
    if (words.length < 2 || !(words[0] === "tmux" || words[0].endsWith("/tmux"))) {
        return null;
    }
    if (!["attach", "attach-session", "a", "at"].includes(words[1])) {
        return null;
    }
    const k = words.indexOf("-t");
    const name = k >= 0 ? words[k + 1]?.replace(/^=/, "") : undefined;
    return name && isSafeSessionName(name) ? name : null;
}

/**
 * The command a pane runs (typed at its prompt) to attach to an EXISTING tmux session: never
 * creates one, and no `exec`, so detaching or a dropped connection lands back in the pane's own
 * shell. `=` makes tmux match the name exactly ("lee" never attaches "lee-identity").
 */
export function buildAttachCommand(host: string, session: string): string | null {
    if (!isSafeSessionName(session)) {
        return null;
    }
    if (!host || host === LocalHost) {
        return shellJoin(["tmux", "attach-session", "-t", "=" + session]);
    }
    if (!parseSshCommand("ssh " + shellQuote(host))) {
        return null;
    }
    const remote = ["sh", "-c", `PATH="$PATH:${RemotePath}"; exec tmux attach-session -t "=$1"`, "sh", session];
    return sshCommand(host, remote, { tty: true });
}

/**
 * Read an old auto-reconnect init script (any of the `exec … tmux new-session -A -s <name>` forms
 * Session Restore, Crew, the agent picker, Detach and Clone Workspace used to write) and return what
 * it connected to, so the pane can offer it instead of running it. Null for anything else.
 */
export function parseLegacyInitScript(script: string): { host: string; session: string } | null {
    if (!script || !script.includes("new-session")) {
        return null;
    }
    const line = script.trim().split("\n")[0];
    const local = splitShellWords(line).filter((w) => w !== "exec");
    // attach-or-create is "new-session -A"; check parsed words (it's quoted in the scripts, and
    // ssh has its own unrelated -A)
    const isAttachOrCreate = (words: string[]) => {
        const k = words.findIndex((w) => w === "tmux" || w.endsWith("/tmux"));
        return k >= 0 && words[k + 1] === "new-session" && words.slice(k + 2).includes("-A");
    };
    const ssh = parseSshCommand(line);
    if (ssh) {
        const remote = splitShellWords(local[local.length - 1] ?? "");
        if (isAttachOrCreate(remote) && ssh.tmuxSession) {
            return { host: ssh.host, session: ssh.tmuxSession };
        }
        // Session Restore form: ssh -t host 'sh -c "… exec tmux new-session -A -s \"$1\"" sh <name>'
        // splitShellWords stops at ";", so read the last statement of the -c script ("exec tmux …")
        const inner = remote[0] === "sh" && remote[1] === "-c" ? splitShellWords((remote[2] ?? "").split(";").pop()) : [];
        const name = remote[remote.length - 1];
        if (isAttachOrCreate(inner) && remote.length === 5 && isSafeSessionName(name)) {
            return { host: ssh.host, session: name };
        }
        return null;
    }
    if (!isAttachOrCreate(local)) {
        return null;
    }
    const k = local.indexOf("-s");
    const name = k >= 0 ? local[k + 1] : undefined;
    return name && isSafeSessionName(name) ? { host: LocalHost, session: name } : null;
}

/**
 * Command listing tmux sessions on `host` as "name|attachedCount" lines (no prompts, short timeout).
 * The separator must be printable: without a UTF-8 locale (Terminus launched from Finder has no LANG)
 * tmux replaces control characters like TAB with "_", which turned "siddig<TAB>1" into "siddig_1".
 */
export function buildListSessionsCommand(host: string): string {
    const remote = [
        "sh",
        "-c",
        `PATH="$PATH:${RemotePath}"; tmux ls -F '#{session_name}|#{session_attached}' 2>/dev/null`,
    ];
    return sshCommand(host, remote, { sshOpts: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] });
}

export function parseSessionList(stdout: string): { name: string; attached: number }[] {
    const rtn: { name: string; attached: number }[] = [];
    for (const line of (stdout ?? "").split("\n")) {
        // strict: anything that isn't exactly "name|count" is ignored rather than guessed at
        const m = line.trim().match(/^([A-Za-z0-9_.-]+)\|(\d+)$/);
        if (m && isSafeSessionName(m[1])) {
            rtn.push({ name: m[1], attached: parseInt(m[2], 10) });
        }
    }
    return rtn;
}

/** "New Site!" → "new-site": what `launch <agent> <project>` accepts as a session suffix. */
export function normalizeProjectName(raw: string): string {
    return (raw ?? "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}
