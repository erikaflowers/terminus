// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { getRepoBasePath } from "@/app/store/agents";
import { createBlock, getApi, WOS } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { shellQuote } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Types ---

type HealthFlag = "dirty" | "unpushed" | "behind" | "stale" | "detached" | "not-main";

type RepoInfo = {
    name: string;
    path: string;
    branch: string;
    isDetached: boolean;
    dirtyCount: number;
    lastCommitMsg: string;
    lastCommitAgo: string;
    lastCommitTs: number;
    lastCommitHash: string;
    remoteUrl: string;
    unpushedCount: number;
    behindCount: number;
    staleDays: number;
    health: HealthFlag[];
};

type SortKey = "name" | "branch" | "status" | "commit" | "ago" | "health";
type SortDir = "asc" | "desc";

// --- Constants ---

const POLL_INTERVAL = 60000;
const STALE_THRESHOLD_DAYS = 7;
const FETCH_INTERVAL = 60 * 60 * 1000; // 1 hour

// --- Shell Commands (dynamic from user prefs) ---

const SCAN_DONE = "---SCAN-DONE";
const SCAN_CONCURRENCY = 4;
const FETCH_CONCURRENCY = 3;
// Never prompt, and give up quickly on unreachable SSH remotes so one slow repo can't stall the rest.
const GIT_NET_ENV = `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o ConnectTimeout=5 -o BatchMode=yes'`;

function normalizeDir(dir: string): string {
    return dir.replace(/\/+$/, "") || "/";
}

/** Only direct children of the configured scan dir are accepted as repo paths. */
function isDirectChild(scanDir: string, repoPath: string): boolean {
    const base = normalizeDir(scanDir);
    const prefix = base === "/" ? "/" : base + "/";
    if (typeof repoPath !== "string" || !repoPath.startsWith(prefix)) return false;
    const name = repoPath.slice(prefix.length);
    return name.length > 0 && name !== "." && name !== ".." && !/[/\n\r]/.test(name);
}

function buildRepoListCommand(scanDir: string): string {
    return `find ${shellQuote(normalizeDir(scanDir))} -mindepth 2 -maxdepth 2 -type d -name .git 2>/dev/null; printf '%s\\n' ${shellQuote(SCAN_DONE)}`;
}

/** Returns the repo paths, or null if the listing failed / timed out (sentinel missing). */
function parseRepoList(scanDir: string, result: { stdout: string; code: number }): string[] | null {
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    if (result.code !== 0 || lines[lines.length - 1] !== SCAN_DONE) return null;
    return lines
        .slice(0, -1)
        .filter((l) => l.endsWith("/.git"))
        .map((l) => l.slice(0, -"/.git".length))
        .filter((p) => isDirectChild(scanDir, p));
}

// printf '%s\n' (not echo): /bin/sh's echo on macOS interprets backslash escapes, which would let a
// commit subject like "x\n---REPO:..." inject extra lines.
function buildRepoStatusCommand(repoPath: string): string {
    const field = (label: string, cmd: string) => `printf '%s\\n' "${label}:$(${cmd})"`;
    return [
        `r=${shellQuote(repoPath)}`,
        field("BRANCH", `git -C "$r" symbolic-ref --short HEAD 2>/dev/null || echo DETACHED`),
        field("DIRTY", `git -C "$r" status --porcelain 2>/dev/null | wc -l | tr -d ' '`),
        field("MSG", `git -C "$r" log -1 --pretty=format:'%s' 2>/dev/null | tr '\\r\\n' '  '`),
        field("AGO", `git -C "$r" log -1 --pretty=format:'%ar' 2>/dev/null`),
        field("TS", `git -C "$r" log -1 --pretty=format:'%ct' 2>/dev/null`),
        field("HASH", `git -C "$r" log -1 --pretty=format:'%H' 2>/dev/null`),
        field("REMOTE", `git -C "$r" remote get-url origin 2>/dev/null | head -1`),
        field("UNPUSHED", `git -C "$r" log @{u}.. --oneline 2>/dev/null | wc -l | tr -d ' '`),
        field("BEHIND", `git -C "$r" rev-list HEAD..@{u} --count 2>/dev/null || echo 0`),
        `printf '%s\\n' ${shellQuote(SCAN_DONE)}`,
    ].join("; ");
}

function buildRepoFetchCommand(repoPath: string): string {
    return `${GIT_NET_ENV} git -C ${shellQuote(repoPath)} fetch --all --quiet 2>/dev/null`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// --- Helpers ---

function remoteToCommitUrl(remoteUrl: string, hash: string): string | null {
    if (!remoteUrl || !hash) return null;
    // git@github.com:user/repo.git → https://github.com/user/repo/commit/HASH
    const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}/commit/${hash}`;
    // https://github.com/user/repo.git → https://github.com/user/repo/commit/HASH
    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}/commit/${hash}`;
    return null;
}

// --- Parsing ---

/** Parse one repo's status output. Returns null if the output is incomplete (failure / timeout). */
function parseRepoStatus(repoPath: string, result: { stdout: string; code: number }): RepoInfo | null {
    const lines = result.stdout.split("\n");
    const nonEmpty = lines.filter((l) => l.length > 0);
    if (result.code !== 0 || nonEmpty[nonEmpty.length - 1] !== SCAN_DONE) return null;
    const get = (prefix: string): string => {
        const line = lines.find((l) => l.startsWith(prefix));
        return line ? line.slice(prefix.length).trim() : "";
    };

    const branch = get("BRANCH:");
    const isDetached = branch === "DETACHED";
    const dirtyCount = parseInt(get("DIRTY:")) || 0;
    const lastCommitMsg = get("MSG:");
    const lastCommitAgo = get("AGO:");
    const lastCommitTs = parseInt(get("TS:")) || 0;
    const lastCommitHash = get("HASH:");
    const remoteUrl = get("REMOTE:");
    const unpushedCount = parseInt(get("UNPUSHED:")) || 0;
    const behindCount = parseInt(get("BEHIND:")) || 0;

    const now = Math.floor(Date.now() / 1000);
    const staleDays = lastCommitTs > 0 ? Math.floor((now - lastCommitTs) / 86400) : 0;

    const health: HealthFlag[] = [];
    if (dirtyCount > 0) health.push("dirty");
    if (unpushedCount > 0) health.push("unpushed");
    if (behindCount > 0) health.push("behind");
    if (staleDays >= STALE_THRESHOLD_DAYS) health.push("stale");
    if (isDetached) health.push("detached");
    if (!isDetached && branch !== "main") health.push("not-main");

    const name = repoPath.split("/").pop() || repoPath;

    return {
        name,
        path: repoPath,
        branch: isDetached ? "HEAD detached" : branch,
        isDetached,
        dirtyCount,
        lastCommitMsg,
        lastCommitAgo,
        lastCommitTs,
        lastCommitHash,
        remoteUrl,
        unpushedCount,
        behindCount,
        staleDays,
        health,
    };
}

// --- Sorting ---

function sortRepos(repos: RepoInfo[], key: SortKey, dir: SortDir): RepoInfo[] {
    const sorted = [...repos];
    const mult = dir === "asc" ? 1 : -1;

    sorted.sort((a, b) => {
        switch (key) {
            case "name":
                return mult * a.name.localeCompare(b.name);
            case "branch":
                return mult * a.branch.localeCompare(b.branch);
            case "status":
                return mult * (b.dirtyCount - a.dirtyCount);
            case "commit":
                return mult * (a.lastCommitMsg || "").localeCompare(b.lastCommitMsg || "");
            case "ago":
                return mult * (b.lastCommitTs - a.lastCommitTs);
            case "health":
                return mult * (b.health.length - a.health.length);
            default:
                return 0;
        }
    });

    return sorted;
}

// --- Colors ---

const healthColors: Record<HealthFlag, string> = {
    dirty: "#ef4444",
    unpushed: "#eab308",
    behind: "#a855f7",
    stale: "#f97316",
    detached: "#ef4444",
    "not-main": "#06b6d4",
};

function branchColor(branch: string, isDetached: boolean): string {
    if (isDetached) return "#ef4444";
    if (branch === "main") return "#22c55e";
    return "#06b6d4";
}

// --- ViewModel ---

class GitDashViewModel implements ViewModel {
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
        this.viewType = "gitdash";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("code-branch");
        this.viewName = jotai.atom("Git");
        this.viewComponent = GitDashView;
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- Components ---

const HealthBadge = React.memo(({ flag }: { flag: HealthFlag }) => {
    const color = healthColors[flag];
    return (
        <span
            style={{
                fontSize: 9,
                padding: "1px 5px",
                borderRadius: 3,
                backgroundColor: `${color}18`,
                color,
                border: `1px solid ${color}40`,
                whiteSpace: "nowrap",
            }}
        >
            {flag}
        </span>
    );
});
HealthBadge.displayName = "HealthBadge";

const SortHeader = React.memo(
    ({
        label,
        sortKey,
        currentKey,
        currentDir,
        onSort,
        style,
    }: {
        label: string;
        sortKey: SortKey;
        currentKey: SortKey;
        currentDir: SortDir;
        onSort: (key: SortKey) => void;
        style?: React.CSSProperties;
    }) => {
        const isActive = currentKey === sortKey;
        return (
            <span
                onClick={() => onSort(sortKey)}
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{
                    color: isActive ? "var(--main-text-color)" : "var(--secondary-text-color)",
                    cursor: "pointer",
                    userSelect: "none",
                    ...style,
                }}
            >
                {label} {isActive ? (currentDir === "asc" ? "\u25B2" : "\u25BC") : ""}
            </span>
        );
    }
);
SortHeader.displayName = "SortHeader";

const RepoRow = React.memo(
    ({
        repo,
        onTerminal,
        onOpen,
        onFetch,
        onPull,
    }: {
        repo: RepoInfo;
        onTerminal: (path: string) => void;
        onOpen: (path: string) => void;
        onFetch: (path: string) => void;
        onPull: (path: string) => void;
    }) => {
        const [hovered, setHovered] = React.useState(false);

        return (
            <div
                className="flex flex-col px-2 py-1.5 rounded-md"
                style={{
                    background: hovered ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                    width: "100%",
                }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {/* Top row: repo / branch / status / ago / health / actions */}
                <div className="flex items-center gap-2" style={{ width: "100%" }}>
                    {/* Repo name */}
                    <div style={{ flex: "2.2 1 0", minWidth: 0 }} className="flex items-center gap-1.5">
                        {repo.behindCount > 0 && (
                            <span
                                className="text-[9px] font-bold flex-shrink-0"
                                style={{
                                    color: "#a855f7",
                                    backgroundColor: "#a855f718",
                                    border: "1px solid #a855f740",
                                    borderRadius: 8,
                                    padding: "0 5px",
                                    lineHeight: "16px",
                                    minWidth: 18,
                                    textAlign: "center",
                                }}
                            >
                                {repo.behindCount}
                            </span>
                        )}
                        <span
                            className="text-[12px] font-semibold truncate"
                            style={{ display: "block", color: "var(--main-text-color)" }}
                        >
                            {repo.name}
                        </span>
                    </div>

                    {/* Branch */}
                    <div style={{ flex: "1.8 1 0", minWidth: 0 }}>
                        <span
                            className="text-[11px] truncate font-mono"
                            style={{ display: "block", color: branchColor(repo.branch, repo.isDetached) }}
                        >
                            {repo.branch}
                        </span>
                    </div>

                    {/* Status */}
                    <div style={{ flex: "1.2 1 0", minWidth: 0 }}>
                        {repo.dirtyCount > 0 ? (
                            <span className="text-[11px]" style={{ color: "#ef4444" }}>
                                dirty {repo.dirtyCount}
                            </span>
                        ) : (
                            <span className="text-[11px]" style={{ color: "#22c55e" }}>
                                clean
                            </span>
                        )}
                    </div>

                    {/* Ago */}
                    <div style={{ flex: "1.2 1 0", minWidth: 0 }}>
                        <span className="text-[11px] text-muted">
                            {repo.lastCommitAgo ? repo.lastCommitAgo.replace(" ago", "") : ""}
                        </span>
                    </div>

                    {/* Health — commented out, redundant with status/behind/dirty indicators
                    <div
                        style={{ flex: "1.5 1 0", minWidth: 0 }}
                        className="flex items-center gap-1 flex-wrap"
                    >
                        {repo.health.length === 0 ? (
                            <span className="text-[11px]" style={{ color: "#22c55e" }}>
                                ok
                            </span>
                        ) : (
                            repo.health.map((flag) => <HealthBadge key={flag} flag={flag} />)
                        )}
                    </div>
                    */}

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0" style={{ width: 100 }}>
                        <button
                            onClick={() => onFetch(repo.path)}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{
                                background: "rgba(255,255,255,0.08)",
                                color: "var(--secondary-text-color)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                cursor: "pointer",
                            }}
                            title={`Fetch ${repo.name}`}
                        >
                            <i className="fa-sharp fa-solid fa-cloud-arrow-down" />
                        </button>
                        <button
                            onClick={() => onPull(repo.path)}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{
                                background: "rgba(255,255,255,0.08)",
                                color: "var(--secondary-text-color)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                cursor: "pointer",
                            }}
                            title={`Pull ${repo.name}`}
                        >
                            <i className="fa-sharp fa-solid fa-arrow-down-to-line" />
                        </button>
                        <button
                            onClick={() => onOpen(repo.path)}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{
                                background: "rgba(255,255,255,0.08)",
                                color: "var(--secondary-text-color)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                cursor: "pointer",
                            }}
                            title={`Open ${repo.name} in Finder`}
                        >
                            <i className="fa-sharp fa-solid fa-folder-open" />
                        </button>
                        <button
                            onClick={() => onTerminal(repo.path)}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{
                                background: "rgba(255,255,255,0.08)",
                                color: "var(--secondary-text-color)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                cursor: "pointer",
                            }}
                            title={`Open terminal in ${repo.name}`}
                        >
                            <i className="fa-sharp fa-solid fa-terminal" />
                        </button>
                    </div>
                </div>

                {/* Bottom row: last commit message */}
                <div className="flex items-center gap-1.5" style={{ width: "100%", marginTop: 1, minWidth: 0 }}>
                    <span className="text-[10px] text-muted truncate" style={{ opacity: 0.6, flex: 1, minWidth: 0 }}>
                        {repo.lastCommitMsg || "no commits"}
                    </span>
                    {(() => {
                        const commitUrl = remoteToCommitUrl(repo.remoteUrl, repo.lastCommitHash);
                        if (!commitUrl) return null;
                        return (
                            <button
                                onClick={() => getApi().openExternal(commitUrl)}
                                className="flex-shrink-0"
                                style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: 0,
                                    color: "var(--secondary-text-color)",
                                    opacity: hovered ? 0.7 : 0,
                                    transition: "opacity 0.15s",
                                    fontSize: 10,
                                    lineHeight: 1,
                                }}
                                title="View commit on GitHub"
                            >
                                <i className="fa-sharp fa-solid fa-arrow-up-right-from-square" />
                            </button>
                        );
                    })()}
                </div>
            </div>
        );
    }
);
RepoRow.displayName = "RepoRow";

// --- Main View ---

const GitDashView: React.FC<ViewComponentProps<GitDashViewModel>> = ({ model }) => {
    const [repos, setRepos] = React.useState<RepoInfo[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [fetching, setFetching] = React.useState(false);
    const [lastFetchTime, setLastFetchTime] = React.useState<number | null>(null);
    const [scanError, setScanError] = React.useState<string | null>(null);
    const [fetchError, setFetchError] = React.useState<string | null>(null);
    const reposRef = React.useRef<RepoInfo[]>([]);
    const refreshPromiseRef = React.useRef<Promise<void> | null>(null);
    const fetchInFlightRef = React.useRef(false);
    const [sortKey, setSortKey] = React.useState<SortKey>("ago");
    const [sortDir, setSortDir] = React.useState<SortDir>("desc");

    const doRefresh = React.useCallback(async () => {
        const scanDir = getRepoBasePath();
        if (!scanDir) {
            reposRef.current = [];
            setRepos([]);
            setScanError(null);
            return;
        }
        try {
            const listResult = await getApi().execCommand(buildRepoListCommand(scanDir));
            const paths = parseRepoList(scanDir, listResult);
            if (paths == null) {
                // Keep the previous list rather than silently shrinking it.
                setScanError("Repo scan failed or timed out; showing previous results.");
                return;
            }
            const previous = new Map(reposRef.current.map((r) => [r.path, r]));
            let failed = 0;
            const scanned = await mapLimit(paths, SCAN_CONCURRENCY, async (repoPath) => {
                const result = await getApi().execCommand(buildRepoStatusCommand(repoPath));
                const info = parseRepoStatus(repoPath, result);
                if (info) return info;
                failed++;
                return previous.get(repoPath) ?? null;
            });
            const next = scanned.filter((r): r is RepoInfo => r != null);
            reposRef.current = next;
            setRepos(next);
            setScanError(failed > 0 ? `${failed} repo(s) failed to scan; showing previous data for them.` : null);
        } catch (e) {
            console.error("Failed to refresh git repos:", e);
            setScanError("Repo scan failed; showing previous results.");
        }
    }, []);

    // Coalesce overlapping refreshes (poll + fetch + button) into one in-flight scan.
    const refreshRepos = React.useCallback(async () => {
        if (refreshPromiseRef.current) return refreshPromiseRef.current;
        setLoading(true);
        const p = doRefresh().finally(() => {
            refreshPromiseRef.current = null;
            setLoading(false);
        });
        refreshPromiseRef.current = p;
        return p;
    }, [doRefresh]);

    const fetchAndRefresh = React.useCallback(async () => {
        const scanDir = getRepoBasePath();
        if (!scanDir || fetchInFlightRef.current) return;
        fetchInFlightRef.current = true;
        setFetching(true);
        try {
            const paths = parseRepoList(scanDir, await getApi().execCommand(buildRepoListCommand(scanDir)));
            if (paths == null) {
                setFetchError("Fetch skipped: repo scan failed or timed out.");
            } else {
                // One command per repo (each with its own timeout), bounded concurrency.
                const codes = await mapLimit(paths, FETCH_CONCURRENCY, async (repoPath) => {
                    const result = await getApi().execCommand(buildRepoFetchCommand(repoPath));
                    return result.code;
                });
                const failed = codes.filter((c) => c !== 0).length;
                if (failed === 0) {
                    setLastFetchTime(Date.now());
                    setFetchError(null);
                } else {
                    setFetchError(`Fetch failed or timed out for ${failed} of ${paths.length} repo(s).`);
                }
            }
        } catch (e) {
            console.error("Failed to fetch repos:", e);
            setFetchError("Fetch failed.");
        }
        await refreshRepos();
        fetchInFlightRef.current = false;
        setFetching(false);
    }, [refreshRepos]);

    // Quick scan on mount + poll every 60s
    React.useEffect(() => {
        refreshRepos();
        const interval = setInterval(refreshRepos, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [refreshRepos]);

    // Fetch on mount + hourly
    React.useEffect(() => {
        fetchAndRefresh();
        const interval = setInterval(fetchAndRefresh, FETCH_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchAndRefresh]);

    const handleSort = React.useCallback(
        (key: SortKey) => {
            if (key === sortKey) {
                setSortDir((d) => (d === "asc" ? "desc" : "asc"));
            } else {
                setSortKey(key);
                setSortDir("asc");
            }
        },
        [sortKey]
    );

    const sortedRepos = React.useMemo(() => sortRepos(repos, sortKey, sortDir), [repos, sortKey, sortDir]);

    const handleTerminal = React.useCallback(async (repoPath: string) => {
        const blockDef: BlockDef = {
            meta: {
                view: "term",
                controller: "shell",
                "cmd:cwd": repoPath,
            },
        };
        await createBlock(blockDef);
    }, []);

    const isKnownRepo = (repoPath: string): boolean => {
        const scanDir = getRepoBasePath();
        return !!scanDir && isDirectChild(scanDir, repoPath);
    };

    const handleOpen = React.useCallback(async (repoPath: string) => {
        if (!isKnownRepo(repoPath)) return;
        await getApi().execCommand(`open ${shellQuote(repoPath)}`);
    }, []);

    const handleFetch = React.useCallback(
        async (repoPath: string) => {
            if (!isKnownRepo(repoPath)) return;
            try {
                await getApi().execCommand(buildRepoFetchCommand(repoPath));
                await refreshRepos();
            } catch (e) {
                console.error("Failed to fetch:", repoPath, e);
            }
        },
        [refreshRepos]
    );

    const handlePull = React.useCallback(
        async (repoPath: string) => {
            if (!isKnownRepo(repoPath)) return;
            try {
                await getApi().execCommand(`${GIT_NET_ENV} git -C ${shellQuote(repoPath)} pull --quiet 2>/dev/null`);
                await refreshRepos();
            } catch (e) {
                console.error("Failed to pull:", repoPath, e);
            }
        },
        [refreshRepos]
    );

    // Summary stats
    const dirtyCount = repos.filter((r) => r.dirtyCount > 0).length;
    const unpushedCount = repos.filter((r) => r.unpushedCount > 0).length;
    const behindCount = repos.filter((r) => r.behindCount > 0).length;
    const staleCount = repos.filter((r) => r.staleDays >= STALE_THRESHOLD_DAYS).length;

    return (
        <div
            className="flex flex-col overflow-hidden"
            style={{
                background: "var(--block-bg-color)",
                flex: "1 1 0",
                minWidth: 0,
                height: "100%",
                alignSelf: "stretch",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 border-b border-white/10"
                style={{ width: "100%" }}
            >
                <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Git</span>
                    <span className="text-[11px] text-muted">{repos.length} tracked</span>
                </div>
                <div className="flex items-center gap-1.5">
                    {(scanError || fetchError) && (
                        <span
                            className="text-[10px]"
                            style={{ color: "#f97316" }}
                            title={[scanError, fetchError].filter(Boolean).join("\n")}
                        >
                            <i className="fa-sharp fa-solid fa-triangle-exclamation" /> stale
                        </span>
                    )}
                    {lastFetchTime && (
                        <span className="text-[10px] text-muted" style={{ opacity: 0.5 }}>
                            fetched {Math.round((Date.now() - lastFetchTime) / 60000)}m ago
                        </span>
                    )}
                    <button
                        onClick={fetchAndRefresh}
                        className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                        title="Fetch all remotes"
                    >
                        <i className={`fa-sharp fa-solid fa-cloud-arrow-down ${fetching ? "fa-spin" : ""}`} />
                    </button>
                    <button
                        onClick={refreshRepos}
                        className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                        title="Refresh"
                    >
                        <i className={`fa-sharp fa-solid fa-arrows-rotate ${loading ? "fa-spin" : ""}`} />
                    </button>
                </div>
            </div>

            {/* Column headers */}
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/5" style={{ width: "100%" }}>
                <div style={{ flex: "2.2 1 0", minWidth: 0 }}>
                    <SortHeader
                        label="Repo"
                        sortKey="name"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                    />
                </div>
                <div style={{ flex: "1.8 1 0", minWidth: 0 }}>
                    <SortHeader
                        label="Branch"
                        sortKey="branch"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                    />
                </div>
                <div style={{ flex: "1.2 1 0", minWidth: 0 }}>
                    <SortHeader
                        label="Status"
                        sortKey="status"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                    />
                </div>
                <div style={{ flex: "1.2 1 0", minWidth: 0 }}>
                    <SortHeader
                        label="Ago"
                        sortKey="ago"
                        currentKey={sortKey}
                        currentDir={sortDir}
                        onSort={handleSort}
                    />
                </div>
                {/* Health header — commented out
                <div style={{ flex: "1.5 1 0", minWidth: 0 }}>
                    <SortHeader label="Health" sortKey="health" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </div>
                */}
                <div style={{ width: 100 }}>
                    <span
                        className="text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: "var(--secondary-text-color)" }}
                    >
                        Actions
                    </span>
                </div>
            </div>

            {/* Scrollable repo list */}
            <div
                className="flex-1 overflow-y-auto px-2 py-1 flex flex-col gap-0.5"
                style={{ width: "100%", minWidth: 0 }}
            >
                {repos.length === 0 && !loading && (
                    <div className="flex items-center justify-center py-8">
                        <span className="text-[12px] text-muted">
                            {getRepoBasePath()
                                ? "No git repos found."
                                : "Set Repo Base Path in Settings to scan for repos."}
                        </span>
                    </div>
                )}
                {sortedRepos.map((repo) => (
                    <RepoRow
                        key={repo.path}
                        repo={repo}
                        onTerminal={handleTerminal}
                        onOpen={handleOpen}
                        onFetch={handleFetch}
                        onPull={handlePull}
                    />
                ))}
            </div>

            {/* Footer summary */}
            {repos.length > 0 && (
                <div className="flex items-center gap-3 px-3 py-2 border-t border-white/10" style={{ width: "100%" }}>
                    {dirtyCount > 0 && (
                        <span className="text-[11px]" style={{ color: "#ef4444" }}>
                            {dirtyCount} dirty
                        </span>
                    )}
                    {unpushedCount > 0 && (
                        <span className="text-[11px]" style={{ color: "#eab308" }}>
                            {unpushedCount} unpushed
                        </span>
                    )}
                    {behindCount > 0 && (
                        <span className="text-[11px]" style={{ color: "#a855f7" }}>
                            {behindCount} behind
                        </span>
                    )}
                    {staleCount > 0 && (
                        <span className="text-[11px]" style={{ color: "#f97316" }}>
                            {staleCount} stale
                        </span>
                    )}
                    <span className="text-[11px] text-muted" style={{ marginLeft: "auto" }}>
                        {repos.length} repos
                    </span>
                </div>
            )}
        </div>
    );
};

export { GitDashViewModel };
