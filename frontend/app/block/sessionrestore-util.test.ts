import { execFileSync, execSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { shellJoin, sshCommand } from "@/util/shellquote";
import {
    buildAttachCommand,
    buildListSessionsCommand,
    LocalHost,
    parseLegacyInitScript,
    parseLocalTmuxAttach,
    parseSessionList,
    parseSshCommand,
} from "./sessionrestore-util";

function hasTmux(): boolean {
    try {
        execSync("tmux -V", { env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

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

describe("buildAttachCommand", () => {
    it("attaches (never creates) the exact remote session, through both shells, with no exec", () => {
        const cmd = buildAttachCommand("erikflowers@mac-studio-2", "siddig");
        expect(cmd.startsWith("ssh -t ")).toBe(true);
        expect(cmd).not.toContain("new-session");
        expect(runWithFakeSsh(cmd)).toBe("HOST=erikflowers@mac-studio-2\nTMUX:attach-session|-t|=siddig|\n");
    });
    it("attaches locally without ssh", () => {
        expect(buildAttachCommand(LocalHost, "lee")).toBe("'tmux' 'attach-session' '-t' '=lee'");
        expect(buildAttachCommand("", "lee")).toBe("'tmux' 'attach-session' '-t' '=lee'");
    });
    it("refuses unsafe names and hosts", () => {
        expect(buildAttachCommand("host", "a;b")).toBeNull();
        expect(buildAttachCommand("host", "$(id)")).toBeNull();
        expect(buildAttachCommand("ho st", "lee")).toBeNull();
        expect(buildAttachCommand("h;x", "lee")).toBeNull();
    });
});

describe("parseLocalTmuxAttach", () => {
    it("reads a typed local attach", () => {
        expect(parseLocalTmuxAttach("tmux attach -t heavy")).toBe("heavy");
        expect(parseLocalTmuxAttach("tmux a -t =lee")).toBe("lee");
        expect(parseLocalTmuxAttach(buildAttachCommand(LocalHost, "siddig"))).toBe("siddig");
    });
    it("ignores everything else", () => {
        for (const c of ["tmux new -s x", "tmux ls", "ls", "", "tmux attach -t 'a;b'"]) {
            expect(parseLocalTmuxAttach(c)).toBeNull();
        }
    });
});

// The exact init scripts older builds wrote (same helpers, same arguments as the removed builders).
const RemotePath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const legacy = {
    sessionRestore: `exec ${sshCommand("erikflowers@mac-studio-2", ["sh", "-c", `PATH="$PATH:${RemotePath}"; exec tmux new-session -A -s "$1"`, "sh", "siddig"], { tty: true })}\n`,
    crewRemote: `exec ${sshCommand("juliansiddig@julians-mac-mini", ["/opt/homebrew/bin/tmux", "new-session", "-A", "-s", "lee", "-c", "/Users/x/claude projects/matilda/agent-lee"], { tty: true })}\n`,
    crewLocal: `exec ${shellJoin(["/opt/homebrew/bin/tmux", "new-session", "-A", "-s", "heavy", "-c", "/Users/x/agent-heavy"])}\n`,
    cloneLocal: `exec ${shellJoin(["tmux", "new-session", "-A", "-s", "renner"])}\n`,
};

describe("parseLegacyInitScript", () => {
    it("reads every old auto-reconnect form", () => {
        expect(parseLegacyInitScript(legacy.sessionRestore)).toEqual({ host: "erikflowers@mac-studio-2", session: "siddig" });
        expect(parseLegacyInitScript(legacy.crewRemote)).toEqual({ host: "juliansiddig@julians-mac-mini", session: "lee" });
        expect(parseLegacyInitScript(legacy.crewLocal)).toEqual({ host: LocalHost, session: "heavy" });
        expect(parseLegacyInitScript(legacy.cloneLocal)).toEqual({ host: LocalHost, session: "renner" });
    });
    it("leaves other init scripts alone", () => {
        for (const c of [null, "", "echo hi\n", "cd ~/x && npm run dev\n", "exec tmux attach -t lee\n", "tmux new -s x\n"]) {
            expect(parseLegacyInitScript(c)).toBeNull();
        }
    });
});

describe("session lists", () => {
    it("list command is non-interactive", () => {
        const cmd = buildListSessionsCommand("mini");
        expect(cmd).toContain("'BatchMode=yes'");
        expect(cmd).toContain("'ConnectTimeout=5'");
    });
    it("parses tmux ls output strictly", () => {
        expect(parseSessionList("lee|1\nrenner|0\nbad name|1\nsiddig_1\n\n")).toEqual([
            { name: "lee", attached: 1 },
            { name: "renner", attached: 0 },
        ]);
    });
    // Regression: Terminus launched from Finder has no LANG; tmux then replaced the old TAB separator
    // with "_" and "siddig<TAB>1" was saved as a session named "siddig_1". Run real tmux without a locale.
    it.skipIf(!hasTmux())("reads session names correctly from real tmux with no locale", () => {
        const sock = "srtest-" + process.pid;
        const env = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME };
        const tmux = (args: string) => execSync(`tmux -L ${sock} ${args}`, { env, encoding: "utf8" });
        try {
            tmux("new-session -d -s siddig");
            tmux("new-session -d -s lee_2");
            // the exact format the list command uses (minus ssh)
            const out = tmux(`ls -F '#{session_name}|#{session_attached}'`);
            expect(parseSessionList(out)).toEqual([
                { name: "lee_2", attached: 0 },
                { name: "siddig", attached: 0 },
            ]);
            expect(buildListSessionsCommand("h")).toContain("#{session_name}|#{session_attached}");
            // "=" matches exactly: with only "lee_2" running, "=lee" must not find it
            tmux("has-session -t =lee_2");
            expect(() => tmux("has-session -t =lee 2>/dev/null")).toThrow();
        } finally {
            try {
                tmux("kill-server");
            } catch {}
        }
    });
});
