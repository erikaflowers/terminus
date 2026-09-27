import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
    buildListSessionsCommand,
    buildSessionRestoreScript,
    parseSessionList,
    parseSshCommand,
} from "./sessionrestore-util";

describe("parseSshCommand", () => {
    it("finds the host, skipping options and their values", () => {
        expect(parseSshCommand("ssh erikflowers@mac-studio-2")).toEqual({ host: "erikflowers@mac-studio-2" });
        expect(parseSshCommand("ssh -p 2222 -i ~/.ssh/k -o BatchMode=yes -A mini")).toEqual({ host: "mini" });
        expect(parseSshCommand("exec ssh -t juliansiddig@julians-mac-mini")).toEqual({
            host: "juliansiddig@julians-mac-mini",
        });
        expect(parseSshCommand("TERM=xterm ssh -tt host")).toEqual({ host: "host" });
    });
    it("picks up a tmux session from the remote command", () => {
        expect(parseSshCommand(`ssh host -t "tmux attach -t siddig"`)).toEqual({ host: "host", tmuxSession: "siddig" });
        expect(parseSshCommand(`ssh -t host tmux new-session -A -s lee`)).toEqual({ host: "host", tmuxSession: "lee" });
        expect(parseSshCommand(`ssh -t host '/opt/homebrew/bin/tmux a -t renner'`)).toEqual({
            host: "host",
            tmuxSession: "renner",
        });
    });
    it("ignores non-ssh commands and junk", () => {
        for (const c of ["ls -la", "sshfs x:/ y", "git push", "", "ssh", "ssh -p 22", "ssh 'a;b'"]) {
            expect(parseSshCommand(c)).toBeNull();
        }
    });
});

// Simulate what really runs: the local zsh parses the init script's ssh argv; ssh joins the
// remote words and the remote /bin/sh parses them. A fake ssh does that, with a fake `tmux`
// program first on PATH (the script appends Homebrew after the existing PATH).
function runWithFakeSsh(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "srtest-"));
    writeFileSync(join(dir, "tmux"), "#!/bin/sh\nprintf 'TMUX:'; printf '%s|' \"$@\"; echo\n", { mode: 0o755 });
    const fake =
        `ssh() { while [ "$#" -gt 1 ]; do case "$1" in -t|-tt) shift;; -o) shift 2;; *) break;; esac; done; ` +
        `printf 'HOST=%s\\n' "$1"; shift; PATH="${dir}:/usr/bin:/bin" /bin/sh -c "$*"; }; `;
    return execFileSync("/bin/zsh", ["-fc", fake + script.replace(/^exec /, "")], { encoding: "utf8" });
}

describe("buildSessionRestoreScript", () => {
    it("reaches the remote tmux with the exact session name, through both shells", () => {
        const script = buildSessionRestoreScript("erikflowers@mac-studio-2", "siddig");
        expect(script.startsWith("exec ssh -t ")).toBe(true);
        expect(runWithFakeSsh(script)).toBe("HOST=erikflowers@mac-studio-2\nTMUX:new-session|-A|-s|siddig|\n");
    });
    it("refuses unsafe names and hosts", () => {
        expect(buildSessionRestoreScript("host", "a;b")).toBeNull();
        expect(buildSessionRestoreScript("host", "$(id)")).toBeNull();
        expect(buildSessionRestoreScript("ho st", "lee")).toBeNull();
        expect(buildSessionRestoreScript("h;x", "lee")).toBeNull();
    });
    it("list command is non-interactive", () => {
        const cmd = buildListSessionsCommand("mini");
        expect(cmd).toContain("'BatchMode=yes'");
        expect(cmd).toContain("'ConnectTimeout=5'");
    });
    it("parses tmux ls output", () => {
        expect(parseSessionList("lee\t1\nrenner\t0\nbad name\t1\n\n")).toEqual([
            { name: "lee", attached: 1 },
            { name: "renner", attached: 0 },
        ]);
    });
});
