// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for Session Restore: recognise an ssh command line, and build the command that
// brings a pane back to "ssh <host> → tmux <session>" (attach-or-create).

import { isSafeSessionName, shellQuote, sshCommand } from "@/util/shellquote";

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
            const name = k >= 0 ? rest[k + 1] : undefined;
            if (name && isSafeSessionName(name)) {
                target.tmuxSession = name;
            }
        }
    }
    return target;
}

/** Init script (cmd:initscript.zsh) that connects to `host` and attaches to (or creates) `session`. */
export function buildSessionRestoreScript(host: string, session: string): string | null {
    if (!parseSshCommand("ssh " + shellQuote(host)) || !isSafeSessionName(session)) {
        return null;
    }
    const remote = ["sh", "-c", `PATH="$PATH:${RemotePath}"; exec tmux new-session -A -s "$1"`, "sh", session];
    // exec: when the connection drops the pane shows "done" and Enter reconnects
    return `exec ${sshCommand(host, remote, { tty: true })}\n`;
}

/** Command listing tmux sessions on `host` as "name<TAB>attachedCount" lines (no prompts, short timeout). */
export function buildListSessionsCommand(host: string): string {
    const remote = [
        "sh",
        "-c",
        `PATH="$PATH:${RemotePath}"; tmux ls -F '#{session_name}\t#{session_attached}' 2>/dev/null`,
    ];
    return sshCommand(host, remote, { sshOpts: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] });
}

export function parseSessionList(stdout: string): { name: string; attached: number }[] {
    return (stdout ?? "")
        .split("\n")
        .map((l) => l.split("\t"))
        .filter(([name]) => isSafeSessionName(name))
        .map(([name, att]) => ({ name, attached: parseInt(att, 10) || 0 }));
}
