import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { isSafeSessionName, shellJoin, shellQuote, sshCommand } from "./shellquote";

// round-trip through a real /bin/sh: printf each argument on its own line
function shArgs(cmdTail: string): string[] {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${cmdTail}`], { encoding: "utf8" });
    return out.split("\n").slice(0, -1);
}

describe("shellQuote", () => {
    const nasty = [
        "plain",
        "has space",
        "it's",
        '"dq"',
        "$(echo pwned)",
        "`id`",
        "a;b|c&d",
        "back\\slash",
        "",
        "new\nline",
    ];
    it("passes every value through sh as exactly one literal argument", () => {
        for (const v of nasty) {
            expect(shArgs(shellQuote(v))).toEqual(v.split("\n").length > 1 ? v.split("\n") : [v]);
        }
    });
    it("shellJoin keeps argument boundaries", () => {
        expect(shArgs(shellJoin(["claude projects/foo", "$(x)", "it's"]))).toEqual([
            "claude projects/foo",
            "$(x)",
            "it's",
        ]);
    });
});

describe("sshCommand", () => {
    it("double-quotes so the remote shell sees the original argv", () => {
        const cmd = sshCommand(
            "host",
            ["tmux", "new-session", "-A", "-s", "lee", "-c", "/Users/x/claude projects/zv"],
            { tty: true }
        );
        // simulate: local sh parses the ssh argv, remote sh parses the joined remote string
        const local = shArgs(cmd.replace(/^ssh /, ""));
        expect(local.slice(0, 2)).toEqual(["-t", "host"]);
        const remoteArgs = shArgs(local[2]);
        expect(remoteArgs).toEqual(["tmux", "new-session", "-A", "-s", "lee", "-c", "/Users/x/claude projects/zv"]);
    });
});

describe("isSafeSessionName", () => {
    it("accepts normal names and rejects shell metacharacters", () => {
        expect(["lee", "renner", "agent_1", "zv-camp", "a.b"].every(isSafeSessionName)).toBe(true);
        expect(["", "a b", "x;y", "$(id)", "it's", "a/b", "x".repeat(65)].some(isSafeSessionName)).toBe(false);
    });
});
