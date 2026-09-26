// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { getRepoBasePath } from "@/app/store/agents";
import { getApi, WOS } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { shellQuote } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Types ---

type DevServer = {
    pid: number;
    process: string;
    port: number;
    project: string;
};

// --- Parsing ---

function parseLsofOutput(stdout: string): { pid: number; process: string; port: number }[] {
    const results: { pid: number; process: string; port: number }[] = [];
    const seen = new Set<string>();
    const lines = stdout.split("\n");

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 9) continue;

        const cmd = parts[0];
        const pid = parseInt(parts[1]);
        const addrPort = parts[8];
        const portStr = addrPort.split(":").pop();
        const port = parseInt(portStr);

        if (isNaN(port) || port < 3000 || port > 9999) continue;
        if (!/node|Python|uvicorn|ruby|php|java|deno|bun/i.test(cmd)) continue;

        const key = `${pid}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ pid, process: cmd, port });
    }

    results.sort((a, b) => a.port - b.port);
    return results;
}

async function resolveProject(pid: number): Promise<string> {
    const basePath = getRepoBasePath();
    if (!basePath) return "(unknown)";
    try {
        const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Filter in JS rather than interpolating basePath into a grep pattern / shell string.
        const result = await getApi().execCommand(`/usr/sbin/lsof -p ${shellQuote(String(pid))} -Fn 2>/dev/null`);
        const line = result.stdout.split("\n").find((l) => l.startsWith("n") && l.includes(basePath + "/"));
        if (!line) return "(unknown)";
        const regex = new RegExp(escaped + "/([^/]+(?:/[^/]+)?)");
        const match = line.match(regex);
        if (match) {
            return match[1].replace(/\/node_modules\/.*/, "");
        }
        return "(unknown)";
    } catch {
        return "(unknown)";
    }
}

const LSOF_DONE = "__TERMINUS_LSOF_DONE__";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Base name of an executable path, as lsof would show it (lsof truncates COMMAND, so compare by prefix). */
function commMatches(psComm: string, lsofCmd: string): boolean {
    const base = psComm.trim().split("/").pop() ?? "";
    if (!base || !lsofCmd) return false;
    return base.startsWith(lsofCmd) || lsofCmd.startsWith(base);
}

/** Re-check that `server.pid` still listens on `server.port` and is still the same command. */
async function verifyServer(server: DevServer): Promise<boolean> {
    const pid = shellQuote(String(server.pid));
    const listen = await getApi().execCommand(
        `/usr/sbin/lsof -a -p ${pid} -iTCP:${shellQuote(String(server.port))} -sTCP:LISTEN -t 2>/dev/null`
    );
    if (listen.code !== 0 || !listen.stdout.split("\n").some((l) => l.trim() === String(server.pid))) {
        return false;
    }
    const ps = await getApi().execCommand(`/bin/ps -o comm= -p ${pid}`);
    if (ps.code !== 0) return false;
    return commMatches(ps.stdout, server.process);
}

async function isAlive(pid: number): Promise<boolean> {
    const result = await getApi().execCommand(`kill -0 ${shellQuote(String(pid))} 2>/dev/null`);
    return result.code === 0;
}

/** Kill exactly the displayed PID: verify it, SIGTERM, wait briefly, SIGKILL only if still alive. */
async function killServer(server: DevServer): Promise<boolean> {
    if (!Number.isInteger(server.pid) || server.pid <= 1) return false;
    if (!(await verifyServer(server))) {
        console.warn(
            `devservers: pid ${server.pid} no longer listens on :${server.port} as ${server.process}; not killing`
        );
        return false;
    }
    const pid = shellQuote(String(server.pid));
    await getApi().execCommand(`kill -TERM ${pid} 2>/dev/null`);
    for (let i = 0; i < 10; i++) {
        await sleep(300);
        if (!(await isAlive(server.pid))) return true;
    }
    await getApi().execCommand(`kill -KILL ${pid} 2>/dev/null`);
    return true;
}

function portColor(port: number): string {
    // Give common port ranges distinct colors
    if (port >= 3000 && port < 4000) return "#22c55e"; // green — Vite, Next, React
    if (port >= 4000 && port < 5000) return "#06b6d4"; // cyan — custom
    if (port >= 5000 && port < 6000) return "#a855f7"; // purple — Flask, etc
    if (port >= 8000 && port < 9000) return "#f59e0b"; // amber — FastAPI, Django
    if (port >= 9000 && port < 10000) return "#ef4444"; // red — misc
    return "#64748b";
}

// --- ViewModel ---

class DevServersViewModel implements ViewModel {
    viewType: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    blockId: string;
    blockAtom: jotai.Atom<Block>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    viewComponent: ViewComponent;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.viewType = "devservers";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("server");
        this.viewName = jotai.atom("Servers");
        this.viewComponent = DevServersView;
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- React Components ---

const ServerCard = React.memo(
    ({
        server,
        onKill,
        onOpen,
    }: {
        server: DevServer;
        onKill: (server: DevServer) => void;
        onOpen: (port: number) => void;
    }) => {
        const color = portColor(server.port);

        return (
            <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{ background: "rgba(255,255,255,0.03)", width: "100%" }}
            >
                <div
                    className="flex items-center justify-center flex-shrink-0 rounded font-mono text-[11px] font-bold"
                    style={{
                        width: 48,
                        height: 28,
                        backgroundColor: `${color}18`,
                        color,
                        border: `1px solid ${color}40`,
                    }}
                >
                    :{server.port}
                </div>
                <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center gap-2">
                        <span
                            className="text-[13px] font-semibold truncate"
                            style={{ color: "var(--main-text-color)" }}
                        >
                            {server.project}
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <span
                            className="inline-block rounded-full"
                            style={{
                                width: 6,
                                height: 6,
                                backgroundColor: "#22c55e",
                                flexShrink: 0,
                            }}
                        />
                        <span className="text-muted">
                            {server.process} · pid {server.pid}
                        </span>
                    </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                    <button
                        onClick={() => onOpen(server.port)}
                        className="px-2 py-1 text-[11px] rounded"
                        style={{
                            background: "rgba(255,255,255,0.08)",
                            color: "var(--main-text-color)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            cursor: "pointer",
                        }}
                        title={`Open localhost:${server.port} in browser`}
                    >
                        Open
                    </button>
                    <button
                        onClick={() => onKill(server)}
                        className="px-2 py-1 text-[11px] rounded"
                        style={{
                            background: "rgba(255,0,0,0.1)",
                            color: "#f87171",
                            border: "1px solid rgba(255,0,0,0.2)",
                            cursor: "pointer",
                        }}
                    >
                        Kill
                    </button>
                </div>
            </div>
        );
    }
);
ServerCard.displayName = "ServerCard";

const DevServersView: React.FC<ViewComponentProps<DevServersViewModel>> = ({ model }) => {
    const [servers, setServers] = React.useState<DevServer[]>([]);
    const [loading, setLoading] = React.useState(false);
    const inFlightRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const timersRef = React.useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    const refreshServers = React.useCallback(async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setLoading(true);
        try {
            // lsof exits 1 when nothing is listening, so use a sentinel to tell "no servers" apart from
            // a failure/timeout. On failure keep the previous list instead of showing "all servers gone".
            const result = await getApi().execCommand(
                `/usr/sbin/lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null; echo ${LSOF_DONE}`
            );
            if (result.code !== 0 || !result.stdout.includes(LSOF_DONE)) {
                console.warn("devservers: lsof failed or timed out; keeping previous list");
                return;
            }
            const parsed = parseLsofOutput(result.stdout.replace(LSOF_DONE, ""));

            // Resolve project names in parallel
            const withProjects = await Promise.all(
                parsed.map(async (s) => {
                    const project = await resolveProject(s.pid);
                    return { ...s, project };
                })
            );

            if (mountedRef.current) setServers(withProjects);
        } catch (e) {
            console.error("Failed to refresh dev servers:", e);
        } finally {
            inFlightRef.current = false;
            if (mountedRef.current) setLoading(false);
        }
    }, []);

    const scheduleRefresh = React.useCallback(
        (ms: number) => {
            const t = setTimeout(() => {
                timersRef.current.delete(t);
                refreshServers();
            }, ms);
            timersRef.current.add(t);
        },
        [refreshServers]
    );

    // Initial load + polling every 30s
    React.useEffect(() => {
        mountedRef.current = true;
        refreshServers();
        const interval = setInterval(refreshServers, 30000);
        const timers = timersRef.current;
        return () => {
            mountedRef.current = false;
            clearInterval(interval);
            timers.forEach((t) => clearTimeout(t));
            timers.clear();
        };
    }, [refreshServers]);

    const handleKill = React.useCallback(
        async (server: DevServer) => {
            await killServer(server);
            // Brief delay for process cleanup, then refresh
            scheduleRefresh(500);
        },
        [scheduleRefresh]
    );

    const handleKillAll = React.useCallback(async () => {
        const targets = [...servers];
        if (targets.length === 0) return;
        const list = targets.map((s) => `  :${s.port}  ${s.process} (pid ${s.pid})  ${s.project}`).join("\n");
        if (!confirm(`Kill ${targets.length} dev server(s)?\n\n${list}`)) return;
        for (const server of targets) {
            await killServer(server);
        }
        scheduleRefresh(500);
    }, [servers, scheduleRefresh]);

    const handleOpen = React.useCallback((port: number) => {
        getApi().openExternal(`http://localhost:${port}`);
    }, []);

    return (
        <div
            className="flex flex-col h-full overflow-hidden"
            style={{ background: "var(--block-bg-color)", width: "100%" }}
        >
            <div
                className="flex items-center justify-between px-3 py-2 border-b border-white/10"
                style={{ width: "100%" }}
            >
                <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Servers</span>
                    <span className="text-[11px] text-muted">{servers.length} running</span>
                </div>
                <button
                    onClick={refreshServers}
                    className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                    title="Refresh"
                >
                    <i className={`fa-sharp fa-solid fa-arrows-rotate ${loading ? "fa-spin" : ""}`} />
                </button>
            </div>
            <div
                className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1"
                style={{ width: "100%", minWidth: 0 }}
            >
                {servers.length === 0 && !loading && (
                    <div className="flex items-center justify-center py-8">
                        <span className="text-[12px] text-muted">No dev servers running.</span>
                    </div>
                )}
                {servers.map((server) => (
                    <ServerCard
                        key={`${server.pid}:${server.port}`}
                        server={server}
                        onKill={handleKill}
                        onOpen={handleOpen}
                    />
                ))}
            </div>
            {servers.length > 0 && (
                <div className="flex gap-2 px-3 py-2 border-t border-white/10" style={{ width: "100%" }}>
                    <button
                        onClick={handleKillAll}
                        className="flex-1 px-2 py-1.5 text-[11px] rounded"
                        style={{
                            background: "rgba(255,0,0,0.08)",
                            color: "#f87171",
                            border: "1px solid rgba(255,0,0,0.15)",
                            cursor: "pointer",
                        }}
                    >
                        Kill All
                    </button>
                </div>
            )}
        </div>
    );
};

export { DevServersViewModel };
