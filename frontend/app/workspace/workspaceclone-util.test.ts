import { describe, expect, it } from "vitest";
import {
    adaptPaneMetaForHere,
    collectLeafBlockIds,
    hostLabel,
    parseTailscaleStatus,
    portablePaneMeta,
    sshTargetFor,
    toSnapshotTree,
} from "./workspaceclone-util";

const tree = {
    id: "r",
    flexDirection: "row",
    size: 10,
    children: [
        { id: "a", flexDirection: "column", size: 10, data: { blockId: "B-siddig" } },
        {
            id: "c",
            flexDirection: "column",
            size: 10,
            children: [
                { id: "d", flexDirection: "row", size: 7, data: { blockId: "B-lee" } },
                { id: "e", flexDirection: "row", size: 3, data: { blockId: "B-renner" } },
            ],
        },
    ],
};

describe("snapshot tree", () => {
    it("keeps shape and sizes, drops ids, maps leaves to indexes", () => {
        const ids = collectLeafBlockIds(tree);
        expect(ids).toEqual(["B-siddig", "B-lee", "B-renner"]);
        const snap = toSnapshotTree(tree, ids);
        expect(JSON.stringify(snap)).not.toContain('"id"');
        expect(snap.children[0].data).toEqual({ blockindex: 0 });
        expect(snap.children[1].children.map((c: any) => [c.size, c.data.blockindex])).toEqual([
            [7, 1],
            [3, 2],
        ]);
    });
    it("drops leaves for unknown blocks and empty branches", () => {
        const snap = toSnapshotTree(tree, ["B-siddig"]);
        expect(snap.children).toHaveLength(1);
    });
});

describe("pane meta", () => {
    const session = {
        view: "term",
        "session:host": "juliansiddig@julians-mac-mini",
        "session:tmux": "lee",
        "cmd:initscript.zsh": "exec ssh old\n",
        "agent:name": "Lee",
    };
    it("drops the source machine's init script for remembered sessions, keeps everything else", () => {
        expect(portablePaneMeta(session)).toEqual({
            view: "term",
            "session:host": "juliansiddig@julians-mac-mini",
            "session:tmux": "lee",
            "agent:name": "Lee",
        });
        expect(portablePaneMeta({ "cmd:initscript.zsh": "x" })).toEqual({ "cmd:initscript.zsh": "x" });
    });
    it("reconnects over ssh elsewhere, attaches locally when the session host is this machine", () => {
        const remote = adaptPaneMetaForHere(portablePaneMeta(session), new Set(["mac-studio-2"]));
        expect(remote["cmd:initscript.zsh"]).toMatch(/^exec ssh -t 'juliansiddig@julians-mac-mini' /);
        const local = adaptPaneMetaForHere(portablePaneMeta(session), new Set(["julians-mac-mini"]));
        expect(local["cmd:initscript.zsh"]).toBe("exec 'tmux' 'new-session' '-A' '-s' 'lee'\n");
    });
    it("leaves unsafe sessions alone", () => {
        const bad = { "session:host": "h", "session:tmux": "a;b" };
        expect(adaptPaneMetaForHere(bad, new Set())).toEqual(bad);
    });
});

describe("machines", () => {
    const status = JSON.stringify({
        Self: {
            HostName: "Erikas-MacBook-Air-2",
            DNSName: "eriks-macbook-air-2.taila3dc77.ts.net.",
            OS: "macOS",
            Online: true,
        },
        Peer: {
            k1: { HostName: "Mac-Studio-4", DNSName: "mac-studio-2.taila3dc77.ts.net.", OS: "macOS", Online: true },
            k2: { HostName: "Julians-Mini", DNSName: "julians-mac-mini.taila3dc77.ts.net.", OS: "macOS", Online: true },
            k3: { HostName: "pantherclaw", DNSName: "pantherclaw.taila3dc77.ts.net.", OS: "linux", Online: false },
        },
    });
    it("parses tailscale status into tailnet names", () => {
        const { self, peers } = parseTailscaleStatus(status);
        expect(self.label).toBe("eriks-macbook-air-2");
        expect(peers.map((p) => [p.label, p.os, p.online])).toEqual([
            ["mac-studio-2", "macos", true],
            ["julians-mac-mini", "macos", true],
            ["pantherclaw", "linux", false],
        ]);
    });
    it("reuses the ssh user from remembered sessions", () => {
        const { peers } = parseTailscaleStatus(status);
        const known = ["erikflowers@mac-studio-2", "juliansiddig@julians-mac-mini"];
        expect(peers.map((p) => sshTargetFor(p, known))).toEqual([
            "erikflowers@mac-studio-2",
            "juliansiddig@julians-mac-mini",
            "pantherclaw",
        ]);
        expect(hostLabel("user@Mac-Studio-2.taila3dc77.ts.net")).toBe("mac-studio-2");
    });
});
