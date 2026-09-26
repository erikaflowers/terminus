// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Helpers for building /bin/sh command strings safely. Many Terminus panels run shell strings
// through getApi().execCommand (child_process.exec), so every interpolated value must be quoted.

/** Quote a value as a single shell word: 'it'\''s' → one argument, no expansion of $, `, \, ". */
export function shellQuote(value: string): string {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Quote each argument and join with spaces. */
export function shellJoin(args: string[]): string {
    return args.map(shellQuote).join(" ");
}

/**
 * Build a command to run on a remote host via ssh. ssh joins its arguments with spaces and hands
 * the result to the remote shell, so the remote command must itself be one quoted word locally.
 * `remoteArgs` are quoted for the remote shell, then the whole string is quoted again for the local one.
 */
export function sshCommand(host: string, remoteArgs: string[], opts?: { tty?: boolean }): string {
    const remote = shellJoin(remoteArgs);
    return ["ssh", ...(opts?.tty ? ["-t"] : []), shellQuote(host), shellQuote(remote)].join(" ");
}

/** tmux session / agent names we accept: letters, digits, _ . - (what tmux itself is happy with). */
export const SafeSessionNameRegex = /^[A-Za-z0-9_.-]+$/;

export function isSafeSessionName(name: string): boolean {
    return typeof name === "string" && name.length > 0 && name.length <= 64 && SafeSessionNameRegex.test(name);
}
