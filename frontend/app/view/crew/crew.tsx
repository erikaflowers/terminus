// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import {
    AgentColorTable,
    buildTmuxAttachInitScript,
    buildTmuxCommand,
    getAgentDir,
    getAgentInfo,
    getAgentsPath,
    globalConfigAtom,
    loadAvatarDataUrl,
    resolveRemoteTmuxPath,
    setRemoteConfig,
    type AgentInfo,
} from "@/app/store/agents";
import { createBlock, getApi, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { isSafeSessionName } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Types ---

type TmuxSessionInfo = {
    name: string;
    windows: number;
    created: Date | null;
    attached: boolean;
};

type CrewAgent = {
    key: string;
    info: AgentInfo | null;
    session: TmuxSessionInfo | null;
    avatarUrl: string | null;
};

// --- Tmux Parsing ---

function parseTmuxLs(stdout: string): TmuxSessionInfo[] {
    const sessions: TmuxSessionInfo[] = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Format: "heavy: 1 windows (created Thu Feb 19 08:19:27 2026) (attached)"
        const match = trimmed.match(/^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)(\s+\(attached\))?/);
        if (match) {
            sessions.push({
                name: match[1],
                windows: parseInt(match[2]),
                created: new Date(match[3]),
                attached: !!match[4],
            });
        }
    }
    return sessions;
}

function formatUptime(created: Date | null): string {
    if (!created) return "";
    const now = Date.now();
    const diff = now - created.getTime();
    if (diff < 0) return "just now";
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// --- Tmux Commands ---

// Session names come from AgentColorTable or from `tmux ls` output (possibly on the remote host),
// so validate them and quote everything via the shellquote helpers.
function buildNewAgentSessionCommand(agentKey: string): string | null {
    if (!isSafeSessionName(agentKey)) {
        console.warn("[crew] skipping unsafe session name", JSON.stringify(agentKey));
        return null;
    }
    const args = ["new-session", "-d", "-s", agentKey];
    const agentDir = getAgentDir(agentKey);
    if (agentDir) {
        args.push("-c", agentDir);
    }
    return buildTmuxCommand(args);
}

function buildKillSessionCommand(agentKey: string): string | null {
    if (!isSafeSessionName(agentKey)) {
        console.warn("[crew] skipping unsafe session name", JSON.stringify(agentKey));
        return null;
    }
    // "=" makes tmux match the session name exactly instead of by prefix
    return buildTmuxCommand(["kill-session", "-t", "=" + agentKey]);
}

// --- ViewModel ---

class CrewViewModel implements ViewModel {
    viewType: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    blockId: string;
    blockAtom: jotai.Atom<Block>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    viewComponent: ViewComponent;
    agentsAtom: jotai.PrimitiveAtom<CrewAgent[]>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;

    constructor(blockId: string, nodeModel: BlockNodeModel, tabModel: TabModel) {
        this.viewType = "crew";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("users");
        this.viewName = jotai.atom("Crew");
        this.viewComponent = CrewView;
        this.agentsAtom = jotai.atom<CrewAgent[]>([]);
        this.loadingAtom = jotai.atom(false);
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- React Component ---

const AgentCard = React.memo(
    ({
        agent,
        onAttach,
        onLaunch,
        onSleep,
    }: {
        agent: CrewAgent;
        onAttach: (name: string) => void;
        onLaunch: (name: string) => void;
        onSleep: (name: string) => void;
    }) => {
        const isRunning = agent.session != null;
        const color = agent.info?.color ?? "#666";
        const displayName = agent.info?.name ?? agent.key;
        const role = agent.info?.role ?? "";

        return (
            <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{ background: "rgba(255,255,255,0.03)", width: "100%" }}
            >
                {agent.avatarUrl ? (
                    <img
                        src={agent.avatarUrl}
                        alt={displayName}
                        className="rounded-full object-cover flex-shrink-0"
                        style={{ width: 32, height: 32, border: `2px solid ${color}` }}
                    />
                ) : (
                    <span
                        className="inline-block rounded-full flex-shrink-0"
                        style={{ width: 32, height: 32, backgroundColor: color, opacity: 0.3 }}
                    />
                )}
                <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold truncate" style={{ color }}>
                            {displayName}
                        </span>
                        <span className="text-[10px] text-muted truncate">{role}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <span
                            className="inline-block rounded-full"
                            style={{
                                width: 6,
                                height: 6,
                                backgroundColor: isRunning ? "#22c55e" : "#666",
                                flexShrink: 0,
                            }}
                        />
                        <span className="text-muted">
                            {isRunning ? `running ${formatUptime(agent.session.created)}` : "stopped"}
                        </span>
                    </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                    {isRunning ? (
                        <>
                            <button
                                onClick={() => onAttach(agent.key)}
                                className="px-2 py-1 text-[11px] rounded"
                                style={{
                                    background: "rgba(255,255,255,0.08)",
                                    color: "var(--main-text-color)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    cursor: "pointer",
                                }}
                            >
                                Attach
                            </button>
                            <button
                                onClick={() => onSleep(agent.key)}
                                className="px-2 py-1 text-[11px] rounded"
                                style={{
                                    background: "rgba(255,0,0,0.1)",
                                    color: "#f87171",
                                    border: "1px solid rgba(255,0,0,0.2)",
                                    cursor: "pointer",
                                }}
                            >
                                Sleep
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={() => onLaunch(agent.key)}
                            className="px-2 py-1 text-[11px] rounded"
                            style={{
                                background: "rgba(34,197,94,0.1)",
                                color: "#4ade80",
                                border: "1px solid rgba(34,197,94,0.2)",
                                cursor: "pointer",
                            }}
                        >
                            Launch
                        </button>
                    )}
                </div>
            </div>
        );
    }
);
AgentCard.displayName = "AgentCard";

const CrewView: React.FC<ViewComponentProps<CrewViewModel>> = ({ model }) => {
    const [agents, setAgents] = React.useState<CrewAgent[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [avatars, setAvatars] = React.useState<Record<string, string | null>>({});
    const agentsPath = jotai.useAtomValue(globalConfigAtom, { store: globalStore }).agentsPath;

    const refreshSessions = React.useCallback(async () => {
        setLoading(true);
        try {
            const cmd = buildTmuxCommand(["ls"]);
            const result = await getApi().execCommand(cmd);
            const sessions = parseTmuxLs(result.stdout);
            const sessionMap = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));

            // Build agent list from AgentColorTable, cross-referencing with tmux sessions
            const allAgents: CrewAgent[] = Object.keys(AgentColorTable).map((key) => {
                const info = getAgentInfo(key);
                const session = sessionMap.get(key) ?? null;
                return { key, info, session, avatarUrl: null };
            });

            // Also include any tmux sessions not in the agent table
            for (const session of sessions) {
                const sKey = session.name.toLowerCase();
                if (!AgentColorTable[sKey]) {
                    allAgents.push({
                        key: sKey,
                        info: null,
                        session,
                        avatarUrl: null,
                    });
                }
            }

            setAgents(allAgents);
        } catch (e) {
            console.error("Failed to refresh tmux sessions:", e);
        }
        setLoading(false);
    }, []);

    // Load avatars on mount (using dynamic repo base path)
    React.useEffect(() => {
        const loadAvatars = async () => {
            const agentsDir = getAgentsPath();
            if (!agentsDir) return;
            console.log("[crew] loading avatars from:", agentsDir + "/portraits/");
            const loaded: Record<string, string | null> = {};
            let successCount = 0;
            for (const key of Object.keys(AgentColorTable)) {
                const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
                const avatarPath = `${agentsDir}/portraits/${capitalized}.jpg`;
                const result = await loadAvatarDataUrl(avatarPath);
                loaded[key] = result;
                if (result) successCount++;
            }
            console.log(`[crew] avatars loaded: ${successCount}/${Object.keys(AgentColorTable).length}`);
            setAvatars(loaded);
        };
        loadAvatars();
    }, [agentsPath]);

    // Initial load + polling
    React.useEffect(() => {
        refreshSessions();
        const interval = setInterval(refreshSessions, 15000);
        return () => clearInterval(interval);
    }, [refreshSessions]);

    const handleAttach = React.useCallback(async (agentKey: string) => {
        const info = getAgentInfo(agentKey);
        const agentName = info?.name ?? agentKey;
        const sessionName = agentKey.toLowerCase();
        const initScript = buildTmuxAttachInitScript(sessionName, getAgentDir(sessionName));
        if (!initScript) return;
        const blockDef: BlockDef = {
            meta: {
                view: "term",
                controller: "shell",
                "agent:name": agentName,
                "agent:color": info?.color ?? null,
                "agent:role": info?.role ?? null,
                "term:theme": info?.defaultTheme ?? null,
                "cmd:initscript.zsh": initScript,
            },
        };
        await createBlock(blockDef);
    }, []);

    const handleLaunch = React.useCallback(
        async (agentKey: string) => {
            const cmd = buildNewAgentSessionCommand(agentKey);
            if (!cmd) return;
            await getApi().execCommand(cmd);
            await refreshSessions();
        },
        [refreshSessions]
    );

    const handleSleep = React.useCallback(
        async (agentKey: string) => {
            const cmd = buildKillSessionCommand(agentKey);
            if (!cmd) return;
            await getApi().execCommand(cmd);
            await refreshSessions();
        },
        [refreshSessions]
    );

    const handleLaunchAll = React.useCallback(async () => {
        const stopped = agents.filter((a) => !a.session);
        for (const agent of stopped) {
            const cmd = buildNewAgentSessionCommand(agent.key);
            if (!cmd) continue;
            await getApi().execCommand(cmd);
        }
        await refreshSessions();
    }, [agents, refreshSessions]);

    const handleSleepAll = React.useCallback(async () => {
        const running = agents.filter((a) => a.session);
        for (const agent of running) {
            const cmd = buildKillSessionCommand(agent.key);
            if (!cmd) continue;
            await getApi().execCommand(cmd);
        }
        await refreshSessions();
    }, [agents, refreshSessions]);

    // Merge avatar data into agents for rendering
    const agentsWithAvatars = React.useMemo(() => {
        return agents.map((a) => ({ ...a, avatarUrl: avatars[a.key] ?? a.avatarUrl }));
    }, [agents, avatars]);

    const activeAgents = agentsWithAvatars.filter((a) => a.session);
    const inactiveAgents = agentsWithAvatars.filter((a) => !a.session);

    // Remote config UI state
    const remoteConfig = jotai.useAtomValue(globalConfigAtom, { store: globalStore });
    const [showRemotePanel, setShowRemotePanel] = React.useState(false);
    const [hostInput, setHostInput] = React.useState(remoteConfig.remoteHost ?? "");
    const [repoPathInput, setRepoPathInput] = React.useState(remoteConfig.repoBasePath ?? "");
    const [tmuxPathInput, setTmuxPathInput] = React.useState(remoteConfig.remoteTmuxPath ?? "");
    const isRemote = !!remoteConfig.remoteHost;

    // Sync inputs when config changes externally
    React.useEffect(() => {
        setHostInput(remoteConfig.remoteHost ?? "");
        setRepoPathInput(remoteConfig.repoBasePath ?? "");
        setTmuxPathInput(remoteConfig.remoteTmuxPath ?? "");
    }, [remoteConfig.remoteHost, remoteConfig.repoBasePath, remoteConfig.remoteTmuxPath]);

    const saveHost = React.useCallback((value: string) => {
        const trimmed = value.trim();
        setRemoteConfig({ remoteHost: trimmed || null });
        // Auto-detect remote tmux path when host is set
        if (trimmed) {
            resolveRemoteTmuxPath();
        }
    }, []);

    const saveRepoPath = React.useCallback((value: string) => {
        const trimmed = value.trim();
        setRemoteConfig({ repoBasePath: trimmed || null });
    }, []);

    const saveTmuxPath = React.useCallback((value: string) => {
        const trimmed = value.trim();
        setRemoteConfig({ remoteTmuxPath: trimmed || null });
    }, []);

    const clearRemote = React.useCallback(() => {
        setRemoteConfig({ remoteHost: null, remoteTmuxPath: null });
        setHostInput("");
        setTmuxPathInput("");
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
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Crew</span>
                    <span className="text-[11px] text-muted">
                        {activeAgents.length}/{agentsWithAvatars.length} running
                    </span>
                </div>
                <button
                    onClick={refreshSessions}
                    className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                    title="Refresh"
                >
                    <i className={`fa-sharp fa-solid fa-arrows-rotate ${loading ? "fa-spin" : ""}`} />
                </button>
            </div>
            {/* Remote mode indicator */}
            <div
                className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 cursor-pointer"
                style={{ width: "100%", background: "rgba(255,255,255,0.02)" }}
                onClick={() => setShowRemotePanel((v) => !v)}
                title="Click to configure remote host"
            >
                <i
                    className={`fa-sharp fa-solid ${isRemote ? "fa-globe" : "fa-laptop"}`}
                    style={{ color: isRemote ? "#22d3ee" : "#666", fontSize: 11 }}
                />
                <span className="text-[11px]" style={{ color: isRemote ? "#22d3ee" : "#888" }}>
                    {isRemote ? `Remote: ${remoteConfig.remoteHost}` : "Local"}
                </span>
                <i
                    className={`fa-sharp fa-solid fa-chevron-${showRemotePanel ? "up" : "down"} ml-auto`}
                    style={{ color: "#666", fontSize: 9 }}
                />
            </div>
            {showRemotePanel && (
                <div
                    className="flex flex-col gap-2 px-3 py-2 border-b border-white/10"
                    style={{ width: "100%", background: "rgba(255,255,255,0.03)" }}
                >
                    <label className="text-[10px] text-muted uppercase tracking-wider">Remote Host</label>
                    <input
                        type="text"
                        value={hostInput}
                        onChange={(e) => setHostInput(e.target.value)}
                        onBlur={() => saveHost(hostInput)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                saveHost(hostInput);
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        placeholder="user@host (e.g. erik@100.64.79.114)"
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                            background: "rgba(0,0,0,0.3)",
                            color: "var(--main-text-color)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            outline: "none",
                            width: "100%",
                        }}
                    />
                    <label className="text-[10px] text-muted uppercase tracking-wider" style={{ marginTop: 4 }}>
                        Repo Base Path
                    </label>
                    <input
                        type="text"
                        value={repoPathInput}
                        onChange={(e) => setRepoPathInput(e.target.value)}
                        onBlur={() => saveRepoPath(repoPathInput)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                saveRepoPath(repoPathInput);
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        placeholder={"/path/to/projects"}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                            background: "rgba(0,0,0,0.3)",
                            color: "var(--main-text-color)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            outline: "none",
                            width: "100%",
                        }}
                    />
                    <label className="text-[10px] text-muted uppercase tracking-wider" style={{ marginTop: 4 }}>
                        Remote Tmux Path
                    </label>
                    <input
                        type="text"
                        value={tmuxPathInput}
                        onChange={(e) => setTmuxPathInput(e.target.value)}
                        onBlur={() => saveTmuxPath(tmuxPathInput)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                saveTmuxPath(tmuxPathInput);
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        placeholder="/opt/homebrew/bin/tmux (auto-detected)"
                        className="text-[11px] px-2 py-1 rounded"
                        style={{
                            background: "rgba(0,0,0,0.3)",
                            color: "var(--main-text-color)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            outline: "none",
                            width: "100%",
                        }}
                    />
                    {isRemote && (
                        <button
                            onClick={clearRemote}
                            className="text-[11px] px-2 py-1 rounded self-start"
                            style={{
                                background: "rgba(255,255,255,0.05)",
                                color: "#888",
                                border: "1px solid rgba(255,255,255,0.1)",
                                cursor: "pointer",
                            }}
                        >
                            Clear (go local)
                        </button>
                    )}
                </div>
            )}
            <div
                className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1"
                style={{ width: "100%", minWidth: 0 }}
            >
                {activeAgents.length > 0 && (
                    <div className="flex flex-col gap-1" style={{ width: "100%" }}>
                        <span
                            className="text-[10px] font-semibold uppercase tracking-wider px-1 pb-0.5"
                            style={{ color: "#22c55e" }}
                        >
                            Active
                        </span>
                        {activeAgents.map((agent) => (
                            <AgentCard
                                key={agent.key}
                                agent={agent}
                                onAttach={handleAttach}
                                onLaunch={handleLaunch}
                                onSleep={handleSleep}
                            />
                        ))}
                    </div>
                )}
                {inactiveAgents.length > 0 && (
                    <div
                        className="flex flex-col gap-1"
                        style={{ width: "100%", marginTop: activeAgents.length > 0 ? 8 : 0 }}
                    >
                        <span
                            className="text-[10px] font-semibold uppercase tracking-wider px-1 pb-0.5"
                            style={{ color: "#666" }}
                        >
                            Inactive
                        </span>
                        {inactiveAgents.map((agent) => (
                            <AgentCard
                                key={agent.key}
                                agent={agent}
                                onAttach={handleAttach}
                                onLaunch={handleLaunch}
                                onSleep={handleSleep}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="flex gap-2 px-3 py-2 border-t border-white/10" style={{ width: "100%" }}>
                <button
                    onClick={handleLaunchAll}
                    className="flex-1 px-2 py-1.5 text-[11px] rounded"
                    style={{
                        background: "rgba(34,197,94,0.08)",
                        color: "#4ade80",
                        border: "1px solid rgba(34,197,94,0.15)",
                        cursor: "pointer",
                    }}
                >
                    Launch All
                </button>
                <button
                    onClick={handleSleepAll}
                    className="flex-1 px-2 py-1.5 text-[11px] rounded"
                    style={{
                        background: "rgba(255,0,0,0.08)",
                        color: "#f87171",
                        border: "1px solid rgba(255,0,0,0.15)",
                        cursor: "pointer",
                    }}
                >
                    Sleep All
                </button>
            </div>
        </div>
    );
};

export { CrewViewModel };
