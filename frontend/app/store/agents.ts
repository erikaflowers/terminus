// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { attachPane, getHomeHost, resetPaneState } from "@/app/block/sessionrestore";
import { atoms, getApi, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isSafeSessionName, shellJoin, sshCommand } from "@/util/shellquote";
import { atom, type PrimitiveAtom } from "jotai";
import { globalStore } from "./jotaiStore";

interface AgentInfo {
    name: string;
    dirName: string;
    color: string;
    role: string;
    avatarPath: string;
    defaultTheme: string;
}

interface GlobalConfig {
    remoteHost: string | null;
    remoteTmuxPath: string | null;
    repoBasePath: string | null;
    agentsPath: string | null;
    githubOrg: string | null;
    plausibleApiKey: string | null;
    plausibleSiteId: string | null;
    cloudSyncUrl: string | null;
    cloudDevicesUrl: string | null;
    cloudOAuthClientId: string | null;
    cloudOAuthClientSecret: string | null;
}

const globalConfigAtom = atom<GlobalConfig>({
    remoteHost: null,
    remoteTmuxPath: null,
    repoBasePath: null,
    agentsPath: null,
    githubOrg: null,
    plausibleApiKey: null,
    plausibleSiteId: null,
    cloudSyncUrl: null,
    cloudDevicesUrl: null,
    cloudOAuthClientId: null,
    cloudOAuthClientSecret: null,
});

// Agent color table — crew manifest
const AgentColorTable: Record<string, { color: string; role: string }> = {
    julian: { color: "#6366F1", role: "Orchestrator" },
    heavy: { color: "#22C55E", role: "Frontend" },
    decker: { color: "#F59E0B", role: "Prose IDE" },
    sellivan: { color: "#8B5CF6", role: "Repo & Docs" },
    qin: { color: "#EF4444", role: "Code Auditor" },
    lee: { color: "#06B6D4", role: "Marketing" },
    manu: { color: "#F97316", role: "Operations" },
    eliza: { color: "#EC4899", role: "Hard Problems" },
    adoni: { color: "#A855F7", role: "Ghostwriter" },
    siddig: { color: "#14B8A6", role: "Backend" },
    renner: { color: "#84CC16", role: "Tool Hacker" },
    clarke: { color: "#64748B", role: "Research" },
    kogan: { color: "#D946EF", role: "Security" },
    reed: { color: "#0EA5E9", role: "Intelligence" },
    renic: { color: "#78716C", role: "DevOps" },
    samantha: { color: "#FF00FF", role: "Systems Auteur" },
};

// Crew themes defined in ~/.config/terminus-dev/termthemes.json
// Convention: "crew-{lowercase_name}"
const CREW_THEME_AGENTS = new Set([
    "julian",
    "heavy",
    "decker",
    "sellivan",
    "qin",
    "lee",
    "manu",
    "eliza",
    "siddig",
    "samantha",
]);

function getDefaultTheme(name: string): string {
    const key = name.toLowerCase();
    if (CREW_THEME_AGENTS.has(key)) {
        return `crew-${key}`;
    }
    return "default-dark";
}

function getAvatarPath(name: string): string {
    const agentsDir = getAgentsPath();
    if (!agentsDir) return "";
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    return `${agentsDir}/portraits/${capitalized}.jpg`;
}

function buildStaticAgentList(): AgentInfo[] {
    return Object.entries(AgentColorTable).map(([key, val]) => ({
        name: key.charAt(0).toUpperCase() + key.slice(1),
        dirName: `agent-${key}`,
        color: val.color,
        role: val.role,
        avatarPath: getAvatarPath(key),
        defaultTheme: getDefaultTheme(key),
    }));
}

const agentsAtom: PrimitiveAtom<AgentInfo[]> = atom(buildStaticAgentList()) as PrimitiveAtom<AgentInfo[]>;

// Cache for loaded avatar data URLs
const avatarCache = new Map<string, string | null>();
const avatarLoadingPromises = new Map<string, Promise<string | null>>();

async function loadAvatarDataUrl(filePath: string): Promise<string | null> {
    if (avatarCache.has(filePath)) {
        return avatarCache.get(filePath);
    }
    if (avatarLoadingPromises.has(filePath)) {
        return avatarLoadingPromises.get(filePath);
    }
    const promise = getApi()
        .readFileBase64(filePath)
        .then((dataUrl) => {
            if (!dataUrl) {
                console.warn(`[avatars] readFileBase64 returned null for: ${filePath}`);
            }
            avatarCache.set(filePath, dataUrl);
            avatarLoadingPromises.delete(filePath);
            return dataUrl;
        })
        .catch((e) => {
            console.warn(`[avatars] failed to load: ${filePath}`, e);
            avatarCache.set(filePath, null);
            avatarLoadingPromises.delete(filePath);
            return null;
        });
    avatarLoadingPromises.set(filePath, promise);
    return promise;
}

function getAgentInfo(name: string): AgentInfo | null {
    if (!name) return null;
    const agents = globalStore.get(agentsAtom);
    const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
    if (agent) {
        // Resolve avatar path dynamically (prefs may have loaded after agent list was built)
        agent.avatarPath = getAvatarPath(agent.name);
    }
    return agent;
}

function getAgentColor(name: string): string | null {
    const info = getAgentInfo(name);
    return info?.color ?? null;
}

// --- Per-Agent Preference Persistence ---

type AgentPrefs = Record<string, string | null>;
const agentPrefsMap = new Map<string, AgentPrefs>();
let prefsLoaded = false;

const GlobalConfigKeys: (keyof GlobalConfig)[] = [
    "remoteHost",
    "remoteTmuxPath",
    "repoBasePath",
    "agentsPath",
    "githubOrg",
    "plausibleApiKey",
    "plausibleSiteId",
    "cloudSyncUrl",
    "cloudDevicesUrl",
    "cloudOAuthClientId",
    "cloudOAuthClientSecret",
];

function getPrefsFilePath(): string {
    return getApi().getConfigDir() + "/agent-preferences.json";
}

// Reads agent-preferences.json from disk. Returns null if the file exists but can't be parsed,
// so callers never overwrite a file they couldn't read. A missing/empty file reads as {}.
async function readPrefsFile(): Promise<Record<string, AgentPrefs> | null> {
    let content: string | null = null;
    try {
        content = await getApi().readTextFile(getPrefsFilePath());
    } catch {
        // treat as missing
    }
    if (!content || !content.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(content);
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
            console.error("[agent-prefs] agent-preferences.json is not a JSON object; not touching it");
            return null;
        }
        return parsed as Record<string, AgentPrefs>;
    } catch (e) {
        console.error("[agent-prefs] failed to parse agent-preferences.json; not touching it", e);
        return null;
    }
}

function globalConfigFromPrefs(globalPrefs: AgentPrefs): GlobalConfig {
    const config = {} as GlobalConfig;
    for (const key of GlobalConfigKeys) {
        config[key] = globalPrefs[key] ?? null;
    }
    return config;
}

let prefsLoadPromise: Promise<void> | null = null;

function loadAgentPreferences(): Promise<void> {
    if (prefsLoadPromise == null) {
        prefsLoadPromise = doLoadAgentPreferences();
    }
    return prefsLoadPromise;
}

async function doLoadAgentPreferences(): Promise<void> {
    if (prefsLoaded) return;
    const parsed = await readPrefsFile();
    if (parsed) {
        for (const [key, prefs] of Object.entries(parsed)) {
            agentPrefsMap.set(key, prefs);
        }
    }
    // Populate global config from _global key
    globalStore.set(globalConfigAtom, globalConfigFromPrefs(agentPrefsMap.get("_global") ?? {}));
    prefsLoaded = true;
}

// Serializes prefs writes within this renderer. Each tab is its own renderer, so every write
// re-reads the file and merges only its own change (read-merge-write) instead of rewriting the
// whole file from this tab's possibly stale copy.
let prefsWriteChain: Promise<void> = Promise.resolve();

function updatePrefsFile(mutate: (prefs: Record<string, AgentPrefs>) => void): Promise<void> {
    const run = async () => {
        // let the initial load land first so it can't overwrite what we merge here
        await loadAgentPreferences();
        const fresh = await readPrefsFile();
        if (fresh == null) {
            // on-disk file is corrupt: keep the change in memory only, never clobber the file
            const snapshot = Object.fromEntries(agentPrefsMap.entries());
            mutate(snapshot);
            for (const [key, prefs] of Object.entries(snapshot)) {
                agentPrefsMap.set(key, prefs);
            }
            return;
        }
        mutate(fresh);
        const obj: Record<string, AgentPrefs> = {};
        for (const [key, prefs] of Object.entries(fresh)) {
            if (prefs && Object.keys(prefs).length > 0) {
                obj[key] = prefs;
            }
        }
        const json = JSON.stringify(obj, null, 2);
        const ok = await getApi().writeTextFile(getPrefsFilePath(), json);
        if (!ok) {
            console.error("[agent-prefs] failed to write agent-preferences.json");
        }
        // adopt the merged copy so this tab also sees other tabs' changes
        agentPrefsMap.clear();
        for (const [key, prefs] of Object.entries(obj)) {
            agentPrefsMap.set(key, prefs);
        }
    };
    const next = prefsWriteChain.then(run, run);
    prefsWriteChain = next.catch((e) => console.error("[agent-prefs] update failed", e));
    return next;
}

function getAgentPrefs(agentName: string): AgentPrefs {
    return agentPrefsMap.get(agentName.toLowerCase()) ?? {};
}

async function setAgentPref(agentName: string, key: string, value: string | null): Promise<void> {
    const name = agentName.toLowerCase();
    await updatePrefsFile((allPrefs) => {
        const prefs = { ...(allPrefs[name] ?? {}) };
        if (value == null) {
            delete prefs[key];
        } else {
            prefs[key] = value;
        }
        allPrefs[name] = prefs;
    });
}

function getGlobalConfig(): GlobalConfig {
    return globalStore.get(globalConfigAtom);
}

// Backward compat alias
function getRemoteConfig(): GlobalConfig {
    return getGlobalConfig();
}

function getRepoBasePath(): string {
    const config = globalStore.get(globalConfigAtom);
    return config.repoBasePath ?? "";
}

function getAgentsPath(): string {
    const config = globalStore.get(globalConfigAtom);
    return config.agentsPath ?? "";
}

function getGithubOrg(): string {
    const config = globalStore.get(globalConfigAtom);
    return config.githubOrg ?? "";
}

function getPlausibleConfig(): { apiKey: string; siteId: string } {
    const config = globalStore.get(globalConfigAtom);
    return {
        apiKey: config.plausibleApiKey ?? "",
        siteId: config.plausibleSiteId ?? "",
    };
}

function getCloudSyncConfig(): { syncUrl: string; devicesUrl: string; clientId: string; clientSecret: string } {
    const config = globalStore.get(globalConfigAtom);
    return {
        syncUrl: config.cloudSyncUrl ?? "",
        devicesUrl: config.cloudDevicesUrl ?? "",
        clientId: config.cloudOAuthClientId ?? "",
        clientSecret: config.cloudOAuthClientSecret ?? "",
    };
}

async function setGlobalConfig(partial: Partial<GlobalConfig>): Promise<void> {
    const current = globalStore.get(globalConfigAtom);
    const updated: GlobalConfig = { ...current, ...partial };
    globalStore.set(globalConfigAtom, updated);
    // Clear remote tmux cache so it re-resolves for new host
    if ("remoteHost" in partial || "remoteTmuxPath" in partial) {
        resolvedRemoteTmuxPath = null;
        if (updated.remoteHost && !updated.remoteTmuxPath) {
            resolveRemoteTmuxPath();
        }
    }
    // Persist only the changed fields into the _global key of the on-disk prefs file
    await updatePrefsFile((allPrefs) => {
        const globalPrefs = { ...(allPrefs["_global"] ?? {}) };
        for (const key of GlobalConfigKeys) {
            if (!(key in partial)) continue;
            if (partial[key] != null) {
                globalPrefs[key] = partial[key];
            } else {
                delete globalPrefs[key];
            }
        }
        allPrefs["_global"] = globalPrefs;
    });
    // pick up _global changes other tabs may have written
    globalStore.set(globalConfigAtom, {
        ...globalConfigFromPrefs(agentPrefsMap.get("_global") ?? {}),
        ...partial,
    });
}

// Backward compat alias
async function setRemoteConfig(partial: Partial<GlobalConfig>): Promise<void> {
    return setGlobalConfig(partial);
}

// Load prefs on module init, then auto-detect the remote tmux path if a host is set without one
loadAgentPreferences().then(() => {
    const config = getGlobalConfig();
    if (config.remoteHost && !config.remoteTmuxPath) {
        resolveRemoteTmuxPath();
    }
});

// --- Tmux Path Resolution (Local + Remote) ---

// Local tmux path — resolved once on the machine running Terminus
let resolvedLocalTmuxPath: string | null = null;

async function resolveLocalTmuxPath(): Promise<string> {
    if (resolvedLocalTmuxPath) return resolvedLocalTmuxPath;
    const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
    for (const p of candidates) {
        try {
            const result = await getApi().execCommand(`test -x ${p} && echo ok`);
            if (result.stdout?.trim() === "ok") {
                resolvedLocalTmuxPath = p;
                return p;
            }
        } catch {
            // continue
        }
    }
    try {
        const result = await getApi().execCommand("which tmux");
        const path = result.stdout?.trim();
        if (path) {
            resolvedLocalTmuxPath = path;
            return path;
        }
    } catch {
        // continue
    }
    resolvedLocalTmuxPath = "tmux";
    return "tmux";
}

function getTmuxPath(): string {
    return resolvedLocalTmuxPath ?? "tmux";
}

// Remote tmux path — resolved via SSH when remoteHost is configured
let resolvedRemoteTmuxPath: string | null = null;
const REMOTE_TMUX_FALLBACK = "/opt/homebrew/bin/tmux";

async function resolveRemoteTmuxPath(): Promise<string> {
    const remote = getRemoteConfig();
    if (!remote?.remoteHost) {
        resolvedRemoteTmuxPath = null;
        return REMOTE_TMUX_FALLBACK;
    }
    try {
        const result = await getApi().execCommand(sshCommand(remote.remoteHost, ["which", "tmux"]));
        const path = result.stdout?.trim();
        if (path) {
            resolvedRemoteTmuxPath = path;
            return path;
        }
    } catch {
        // SSH failed or tmux not found
    }
    resolvedRemoteTmuxPath = REMOTE_TMUX_FALLBACK;
    return REMOTE_TMUX_FALLBACK;
}

function getRemoteTmuxPath(): string {
    const remote = getRemoteConfig();
    // User override > auto-detected > fallback
    return remote?.remoteTmuxPath ?? resolvedRemoteTmuxPath ?? REMOTE_TMUX_FALLBACK;
}

// Single helper: returns the correct tmux path for the current mode
function getTmuxCmd(): string {
    const remote = getRemoteConfig();
    if (remote?.remoteHost) {
        return getRemoteTmuxPath();
    }
    return getTmuxPath();
}

// Resolve local on module load
resolveLocalTmuxPath();

// --- Tmux Command Builders ---

/** A /bin/sh command running tmux with `args`, locally or on the configured remote host. */
function buildTmuxCommand(args: string[], opts?: { tty?: boolean }): string {
    const remote = getRemoteConfig();
    const tmux = getTmuxCmd();
    if (remote?.remoteHost) {
        return sshCommand(remote.remoteHost, [tmux, ...args], opts);
    }
    return shellJoin([tmux, ...args]);
}

/** Directory an agent's tmux session starts in (same as Crew's spawn), or "" if agentsPath isn't set. */
function getAgentDir(agentKey: string): string {
    const agentsDir = getAgentsPath();
    return agentsDir ? `${agentsDir}/agent-${agentKey.toLowerCase()}` : "";
}

// --- Tmux Session Switching via ForceRestart ---

/**
 * Point a pane at an agent (or at nothing): restart it as a clean local shell that remembers the
 * agent's session where sessions live, then attach by typing at its prompt. Detaching leaves the
 * local shell; nothing reconnects on its own (see block/sessionrestore.ts).
 */
async function forceRestartWithAgent(blockId: string, agentName: string | null): Promise<void> {
    const tabId = globalStore.get(atoms.staticTabId);
    const session = agentName ? agentName.toLowerCase() : null;
    if (session && !isSafeSessionName(session)) {
        return;
    }
    const home = getHomeHost();
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: {
            "cmd:initscript.zsh": null,
            "session:host": session ? home : null,
            "session:tmux": session,
            "session:off": null,
        },
    });
    resetPaneState(blockId);
    await RpcApi.ControllerResyncCommand(TabRpcClient, {
        tabid: tabId,
        blockid: blockId,
        forcerestart: true,
    });
    if (session) {
        await attachPane(blockId, home, session);
    }
}

export {
    AgentColorTable,
    agentsAtom,
    buildTmuxCommand,
    forceRestartWithAgent,
    getAgentColor,
    getAgentDir,
    getAgentInfo,
    getAgentPrefs,
    getAgentsPath,
    getCloudSyncConfig,
    getGithubOrg,
    getGlobalConfig,
    getPlausibleConfig,
    getRemoteConfig,
    getRemoteTmuxPath,
    getRepoBasePath,
    getTmuxCmd,
    getTmuxPath,
    globalConfigAtom,
    loadAgentPreferences,
    loadAvatarDataUrl,
    resolveRemoteTmuxPath,
    setAgentPref,
    setGlobalConfig,
    setRemoteConfig,
};
export type { AgentInfo, GlobalConfig };
