// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, WOS } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { shellQuote } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Types ---

type TimeRange = "1d" | "7d" | "30d";

type CostItem = {
    model: string | null;
    costType: string | null;
    tokenType: string | null;
    amount: number; // cents
    serviceTier: string | null;
};

type CostBucket = {
    startingAt: string;
    endingAt: string;
    items: CostItem[];
};

type UsageBucket = {
    startingAt: string;
    endingAt: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
};

type ModelUsageSummary = {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costCents: number;
};

type ClaudeCodeMetrics = {
    sessions: number;
    linesAdded: number;
    linesRemoved: number;
    commits: number;
    pullRequests: number;
    editAccepted: number;
    editRejected: number;
    writeAccepted: number;
    writeRejected: number;
};

type UsageData = {
    orgName: string;
    totalCostCents: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    modelBreakdown: ModelUsageSummary[];
    dailyCosts: { date: string; costCents: number }[];
    claudeCode: ClaudeCodeMetrics | null;
    error: string | null;
};

// --- Constants ---

const API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const KEY_FILE = "admin-api-key.txt";

// --- Helpers ---

function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return n.toString();
}

function formatCost(cents: number): string {
    return "$" + (cents / 100).toFixed(2);
}

function cacheHitRate(cacheRead: number, uncachedInput: number): string {
    const total = cacheRead + uncachedInput;
    if (total === 0) return "—";
    return Math.round((cacheRead / total) * 100) + "%";
}

function getTimeRangeParams(range: TimeRange): { startingAt: string; endingAt: string } {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    let start: Date;
    switch (range) {
        case "1d":
            // Use yesterday→tomorrow to ensure a valid range even with daily bucket snapping
            start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
            break;
        case "7d":
            start = new Date(end.getTime() - 7 * 86400000);
            break;
        case "30d":
            start = new Date(end.getTime() - 30 * 86400000);
            break;
    }
    return {
        startingAt: start.toISOString(),
        endingAt: end.toISOString(),
    };
}

function shortModelName(model: string): string {
    // "claude-sonnet-4-20250514" → "sonnet 4"
    // "claude-sonnet-4-5-20250929" → "sonnet 4.5"
    // "claude-opus-4-6" → "opus 4.6"
    // "claude-haiku-4-5-20251001" → "haiku 4.5"
    let m = model.replace(/^claude-/, "");
    // Strip trailing date stamp (8+ digits)
    m = m.replace(/-\d{8,}$/, "");
    // Convert version segments: "opus-4-6" → "opus 4.6", "sonnet-4" → "sonnet 4"
    m = m.replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
    return m;
}

// --- Data Fetching ---

function apiKeyPath(): string {
    return getApi().getConfigDir() + "/" + KEY_FILE;
}

/** Returns the path of the key file if it holds a usable key, else null. The key itself never leaves this function. */
async function loadApiKey(): Promise<string | null> {
    const keyPath = apiKeyPath();
    const raw = await getApi().readTextFile(keyPath);
    const key = raw ? raw.trim() : "";
    // Must fit on one curl config line: no quotes, backslashes, or whitespace.
    if (!key || /["\\\s]/.test(key)) return null;
    return keyPath;
}

function buildCurlCmd(keyPath: string, endpoint: string, params: [string, string][]): string {
    // Build query string manually to preserve literal [] brackets (URLSearchParams encodes them as %5B%5D)
    const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const url = qs ? `${API_BASE}${endpoint}?${qs}` : `${API_BASE}${endpoint}`;
    // The x-api-key header is fed to curl as a config file on stdin, built by shell builtins reading the
    // key file, so the key never appears in any process's argv (visible in `ps`) or in this command string.
    const header = `{ printf '%s' 'header = "x-api-key: '; tr -d ' \\t\\r\\n' < ${shellQuote(keyPath)}; printf '"\\n'; }`;
    return `${header} | curl -s --max-time 9 --config - ${shellQuote(url)} -H ${shellQuote(`anthropic-version: ${API_VERSION}`)}`;
}

async function fetchCostReport(keyPath: string, range: TimeRange): Promise<CostBucket[]> {
    const { startingAt, endingAt } = getTimeRangeParams(range);
    const cmd = buildCurlCmd(keyPath, "/v1/organizations/cost_report", [
        ["starting_at", startingAt],
        ["ending_at", endingAt],
        ["bucket_width", "1d"],
        ["group_by[]", "description"],
    ]);

    const result = await getApi().execCommand(cmd);
    if (result.code !== 0 || !result.stdout) {
        console.error("[usage] cost_report failed, code:", result.code);
        throw new Error(`Cost API request failed (exit ${result.code}${result.stdout ? "" : ", empty response"})`);
    }

    const json = JSON.parse(result.stdout);
    if (json.error) {
        console.error("[usage] cost_report API error:", json.error);
        throw new Error(`Cost API: ${json.error?.message || JSON.stringify(json.error)}`);
    }

    const buckets: CostBucket[] = [];
    for (const bucket of json.data || []) {
        const items: CostItem[] = [];
        for (const r of bucket.results || []) {
            items.push({
                model: r.model || null,
                costType: r.cost_type || null,
                tokenType: r.token_type || null,
                amount: parseFloat(r.amount) || 0,
                serviceTier: r.service_tier || null,
            });
        }
        buckets.push({
            startingAt: bucket.starting_at,
            endingAt: bucket.ending_at,
            items,
        });
    }

    return buckets;
}

async function fetchUsageReport(keyPath: string, range: TimeRange): Promise<{ byModel: ModelUsageSummary[] }> {
    const { startingAt, endingAt } = getTimeRangeParams(range);
    const cmd = buildCurlCmd(keyPath, "/v1/organizations/usage_report/messages", [
        ["starting_at", startingAt],
        ["ending_at", endingAt],
        ["bucket_width", "1d"],
        ["group_by[]", "model"],
    ]);

    const result = await getApi().execCommand(cmd);
    if (result.code !== 0 || !result.stdout) {
        console.error("[usage] usage_report failed, code:", result.code);
        throw new Error(`Usage API request failed (exit ${result.code}${result.stdout ? "" : ", empty response"})`);
    }

    const json = JSON.parse(result.stdout);
    if (json.error) {
        console.error("[usage] usage_report API error:", json.error);
        throw new Error(`Usage API: ${json.error?.message || JSON.stringify(json.error)}`);
    }
    console.log(
        "[usage] usage_report buckets:",
        json.data?.length,
        "first:",
        JSON.stringify(json.data?.[0])?.slice(0, 300)
    );

    const modelMap = new Map<string, ModelUsageSummary>();

    for (const bucket of json.data || []) {
        for (const r of bucket.results || []) {
            const model = r.model || "unknown";
            let entry = modelMap.get(model);
            if (!entry) {
                entry = {
                    model,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    costCents: 0,
                };
                modelMap.set(model, entry);
            }
            entry.inputTokens += r.uncached_input_tokens || 0;
            entry.outputTokens += r.output_tokens || 0;
            entry.cacheReadTokens += r.cache_read_input_tokens || 0;
            const cacheCreation = r.cache_creation || {};
            entry.cacheCreationTokens +=
                (cacheCreation.ephemeral_1h_input_tokens || 0) + (cacheCreation.ephemeral_5m_input_tokens || 0);
        }
    }

    return { byModel: Array.from(modelMap.values()) };
}

async function fetchClaudeCodeMetrics(keyPath: string): Promise<ClaudeCodeMetrics | null> {
    // Claude Code analytics is daily — fetch today
    const now = new Date();
    const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    const cmd = buildCurlCmd(keyPath, "/v1/organizations/usage_report/claude_code", [
        ["starting_at", dateStr],
        ["limit", "100"],
    ]);

    const result = await getApi().execCommand(cmd);
    if (!result.stdout) return null;

    let json: any;
    try {
        json = JSON.parse(result.stdout);
    } catch {
        return null;
    }

    if (json.error) return null;

    const metrics: ClaudeCodeMetrics = {
        sessions: 0,
        linesAdded: 0,
        linesRemoved: 0,
        commits: 0,
        pullRequests: 0,
        editAccepted: 0,
        editRejected: 0,
        writeAccepted: 0,
        writeRejected: 0,
    };

    for (const record of json.data || []) {
        const core = record.core_metrics || {};
        metrics.sessions += core.num_sessions || 0;
        metrics.linesAdded += core.lines_of_code?.added || 0;
        metrics.linesRemoved += core.lines_of_code?.removed || 0;
        metrics.commits += core.commits_by_claude_code || 0;
        metrics.pullRequests += core.pull_requests_by_claude_code || 0;

        const tools = record.tool_actions || {};
        metrics.editAccepted += tools.edit_tool?.accepted || 0;
        metrics.editRejected += tools.edit_tool?.rejected || 0;
        metrics.writeAccepted += tools.write_tool?.accepted || 0;
        metrics.writeRejected += tools.write_tool?.rejected || 0;
    }

    return metrics;
}

async function fetchOrgName(keyPath: string): Promise<string> {
    const cmd = buildCurlCmd(keyPath, "/v1/organizations/me", []);
    const result = await getApi().execCommand(cmd);
    console.log("[usage] org/me response:", result.stdout?.slice(0, 200), "stderr:", result.stderr?.slice(0, 200));
    try {
        const json = JSON.parse(result.stdout);
        if (json.error) {
            console.error("[usage] org/me API error:", json.error);
            throw new Error(`Auth failed: ${json.error?.message || JSON.stringify(json.error)}`);
        }
        return json.name || "Org";
    } catch (e) {
        if (e instanceof Error && e.message.startsWith("Auth failed")) throw e;
        return "Org";
    }
}

async function fetchAllData(keyPath: string, range: TimeRange): Promise<UsageData> {
    try {
        const [costBuckets, usageReport, orgName] = await Promise.all([
            fetchCostReport(keyPath, range),
            fetchUsageReport(keyPath, range),
            fetchOrgName(keyPath),
        ]);
        const claudeCode: ClaudeCodeMetrics | null = null; // disabled: only tracks org API usage, not Max plan

        // Aggregate cost totals
        let totalCostCents = 0;
        const dailyCosts: { date: string; costCents: number }[] = [];
        for (const bucket of costBuckets) {
            let bucketCost = 0;
            for (const item of bucket.items) {
                bucketCost += item.amount;
            }
            totalCostCents += bucketCost;
            dailyCosts.push({ date: bucket.startingAt.slice(0, 10), costCents: bucketCost });
        }

        // Merge cost data into usage model breakdown
        const costByModel = new Map<string, number>();
        for (const bucket of costBuckets) {
            for (const item of bucket.items) {
                if (item.model) {
                    costByModel.set(item.model, (costByModel.get(item.model) || 0) + item.amount);
                }
            }
        }

        // Enrich usage models with cost
        for (const m of usageReport.byModel) {
            m.costCents = costByModel.get(m.model) || 0;
        }

        // Aggregate tokens
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheReadTokens = 0;
        let totalCacheCreationTokens = 0;
        for (const m of usageReport.byModel) {
            totalInputTokens += m.inputTokens;
            totalOutputTokens += m.outputTokens;
            totalCacheReadTokens += m.cacheReadTokens;
            totalCacheCreationTokens += m.cacheCreationTokens;
        }

        // Sort models by cost descending
        const modelBreakdown = usageReport.byModel.sort((a, b) => b.costCents - a.costCents);

        return {
            orgName,
            totalCostCents,
            totalInputTokens,
            totalOutputTokens,
            totalCacheReadTokens,
            totalCacheCreationTokens,
            modelBreakdown,
            dailyCosts,
            claudeCode,
            error: null,
        };
    } catch (e) {
        return {
            orgName: "",
            totalCostCents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            modelBreakdown: [],
            dailyCosts: [],
            claudeCode: null,
            error: e instanceof Error ? e.message : "Unknown error",
        };
    }
}

// --- ViewModel ---

class UsageViewModel implements ViewModel {
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
        this.viewType = "usage";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("gauge");
        this.viewName = jotai.atom("Usage");
        this.viewComponent = UsageView;
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- Components ---

const SummaryCard = React.memo(({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div
        style={{
            flex: "1 1 0",
            minWidth: 0,
            padding: "10px 12px",
            borderRadius: 6,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
        }}
    >
        <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--secondary-text-color)", marginBottom: 4 }}
        >
            {label}
        </div>
        <div className="text-[18px] font-bold" style={{ color: "var(--main-text-color)" }}>
            {value}
        </div>
        {sub && (
            <div className="text-[10px]" style={{ color: "var(--secondary-text-color)", marginTop: 2 }}>
                {sub}
            </div>
        )}
    </div>
));
SummaryCard.displayName = "SummaryCard";

const CostBar = React.memo(({ pct, color }: { pct: number; color: string }) => (
    <div
        style={{
            width: "100%",
            height: 4,
            borderRadius: 2,
            background: "rgba(255,255,255,0.06)",
            overflow: "hidden",
        }}
    >
        <div
            style={{
                width: `${Math.min(100, pct)}%`,
                height: "100%",
                borderRadius: 2,
                background: color,
                transition: "width 0.3s ease",
            }}
        />
    </div>
));
CostBar.displayName = "CostBar";

const MODEL_COLORS = [
    "#a78bfa", // violet
    "#60a5fa", // blue
    "#34d399", // emerald
    "#fbbf24", // amber
    "#f87171", // red
    "#38bdf8", // sky
    "#fb923c", // orange
    "#818cf8", // indigo
];

const ModelRow = React.memo(
    ({ model, maxCost, colorIdx }: { model: ModelUsageSummary; maxCost: number; colorIdx: number }) => {
        const pct = maxCost > 0 ? (model.costCents / maxCost) * 100 : 0;
        const color = MODEL_COLORS[colorIdx % MODEL_COLORS.length];
        const totalInput = model.inputTokens + model.cacheReadTokens + model.cacheCreationTokens;

        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                        className="text-[11px] font-mono"
                        style={{ color: "var(--main-text-color)", flex: "2 1 0", minWidth: 0 }}
                    >
                        {shortModelName(model.model)}
                    </span>
                    <span
                        className="text-[10px]"
                        style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                    >
                        {formatTokens(totalInput)} in
                    </span>
                    <span
                        className="text-[10px]"
                        style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                    >
                        {formatTokens(model.outputTokens)} out
                    </span>
                    <span
                        className="text-[10px]"
                        style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                    >
                        {cacheHitRate(model.cacheReadTokens, model.inputTokens)}
                    </span>
                    <span
                        className="text-[11px] font-semibold"
                        style={{ color: "var(--main-text-color)", flex: "1 1 0", textAlign: "right" }}
                    >
                        {formatCost(model.costCents)}
                    </span>
                </div>
                <CostBar pct={pct} color={color} />
            </div>
        );
    }
);
ModelRow.displayName = "ModelRow";

const ClaudeCodeSection = React.memo(({ metrics }: { metrics: ClaudeCodeMetrics }) => {
    const editTotal = metrics.editAccepted + metrics.editRejected;
    const writeTotal = metrics.writeAccepted + metrics.writeRejected;
    const editRate = editTotal > 0 ? Math.round((metrics.editAccepted / editTotal) * 100) : 0;
    const writeRate = writeTotal > 0 ? Math.round((metrics.writeAccepted / writeTotal) * 100) : 0;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--secondary-text-color)" }}
            >
                Claude Code — Today
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <StatChip label="Sessions" value={metrics.sessions.toString()} />
                <StatChip label="LOC +" value={metrics.linesAdded.toLocaleString()} color="#22c55e" />
                <StatChip label="LOC −" value={metrics.linesRemoved.toLocaleString()} color="#ef4444" />
                <StatChip label="Commits" value={metrics.commits.toString()} />
                <StatChip label="PRs" value={metrics.pullRequests.toString()} />
            </div>
            {editTotal > 0 && (
                <div style={{ display: "flex", gap: 12, marginTop: 2 }}>
                    <span className="text-[10px]" style={{ color: "var(--secondary-text-color)" }}>
                        Edit accept: <span style={{ color: "var(--main-text-color)" }}>{editRate}%</span>{" "}
                        <span style={{ opacity: 0.5 }}>
                            ({metrics.editAccepted}/{editTotal})
                        </span>
                    </span>
                    {writeTotal > 0 && (
                        <span className="text-[10px]" style={{ color: "var(--secondary-text-color)" }}>
                            Write accept: <span style={{ color: "var(--main-text-color)" }}>{writeRate}%</span>{" "}
                            <span style={{ opacity: 0.5 }}>
                                ({metrics.writeAccepted}/{writeTotal})
                            </span>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
});
ClaudeCodeSection.displayName = "ClaudeCodeSection";

const StatChip = React.memo(({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div
        style={{
            padding: "3px 8px",
            borderRadius: 4,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
        }}
    >
        <span className="text-[9px] uppercase" style={{ color: "var(--secondary-text-color)" }}>
            {label}{" "}
        </span>
        <span className="text-[11px] font-semibold" style={{ color: color || "var(--main-text-color)" }}>
            {value}
        </span>
    </div>
));
StatChip.displayName = "StatChip";

const DailyBar = React.memo(({ costs, maxCost }: { costs: { date: string; costCents: number }[]; maxCost: number }) => {
    if (costs.length === 0) return null;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--secondary-text-color)" }}
            >
                Daily Cost
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
                {costs.map((d) => {
                    const h = maxCost > 0 ? Math.max(2, (d.costCents / maxCost) * 36) : 2;
                    return (
                        <div
                            key={d.date}
                            title={`${d.date}: ${formatCost(d.costCents)}`}
                            style={{
                                flex: "1 1 0",
                                height: h,
                                borderRadius: 2,
                                background: "#a78bfa",
                                opacity: 0.7,
                                minWidth: 3,
                                transition: "height 0.3s ease",
                            }}
                        />
                    );
                })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="text-[9px]" style={{ color: "var(--secondary-text-color)" }}>
                    {costs[0]?.date}
                </span>
                <span className="text-[9px]" style={{ color: "var(--secondary-text-color)" }}>
                    {costs[costs.length - 1]?.date}
                </span>
            </div>
        </div>
    );
});
DailyBar.displayName = "DailyBar";

// --- Setup View (no API key) ---

const SetupView = React.memo(({ onRefresh }: { onRefresh?: () => void }) => {
    const configDir = getApi().getConfigDir();
    return (
        <div className="flex flex-col items-center justify-center" style={{ height: "100%", gap: 12, padding: 24 }}>
            <i
                className="fa-sharp fa-solid fa-key"
                style={{ fontSize: 24, color: "var(--secondary-text-color)", opacity: 0.5 }}
            />
            <span className="text-[12px] font-semibold" style={{ color: "var(--main-text-color)" }}>
                API Key Required
            </span>
            <span
                className="text-[11px]"
                style={{ color: "var(--secondary-text-color)", textAlign: "center", maxWidth: 300 }}
            >
                Save your Anthropic Admin API key to:
            </span>
            <code
                className="text-[10px] font-mono"
                style={{
                    color: "#a78bfa",
                    background: "rgba(255,255,255,0.06)",
                    padding: "4px 10px",
                    borderRadius: 4,
                    userSelect: "all",
                }}
            >
                {configDir}/{KEY_FILE}
            </code>
            <span
                className="text-[10px]"
                style={{ color: "var(--secondary-text-color)", textAlign: "center", maxWidth: 300, opacity: 0.7 }}
            >
                Generate an Admin API key (sk-ant-admin...) from the Claude Console under Settings → Admin Keys.
            </span>
            {onRefresh && (
                <span
                    onClick={onRefresh}
                    className="text-[11px]"
                    style={{
                        color: "#a78bfa",
                        cursor: "pointer",
                        marginTop: 4,
                    }}
                >
                    I've added my key — refresh
                </span>
            )}
        </div>
    );
});
SetupView.displayName = "SetupView";

// --- Main View ---

const UsageView: React.FC<ViewComponentProps<UsageViewModel>> = ({ model }) => {
    const [data, setData] = React.useState<UsageData | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [range, setRange] = React.useState<TimeRange>("7d");
    const [hasKey, setHasKey] = React.useState<boolean | null>(null);
    const requestIdRef = React.useRef(0);

    const refresh = React.useCallback(async () => {
        // A late response for an older range/refresh must not overwrite a newer one.
        const requestId = ++requestIdRef.current;
        setLoading(true);
        const keyPath = await loadApiKey();
        if (requestId !== requestIdRef.current) return;
        if (!keyPath) {
            setHasKey(false);
            setLoading(false);
            return;
        }
        setHasKey(true);
        const result = await fetchAllData(keyPath, range);
        if (requestId !== requestIdRef.current) return;
        setData(result);
        setLoading(false);
    }, [range]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    if (hasKey === false) {
        return (
            <div
                className="flex flex-col overflow-hidden"
                style={{ background: "var(--block-bg-color)", flex: "1 1 0", minWidth: 0, height: "100%" }}
            >
                <SetupView onRefresh={refresh} />
            </div>
        );
    }

    const maxDailyCost = data ? Math.max(...data.dailyCosts.map((d) => d.costCents), 0) : 0;
    const maxModelCost = data?.modelBreakdown?.[0]?.costCents || 0;

    return (
        <div
            className="flex flex-col overflow-hidden"
            style={{ background: "var(--block-bg-color)", flex: "1 1 0", minWidth: 0, height: "100%" }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 border-b border-white/10"
                style={{ width: "100%" }}
            >
                <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Usage</span>
                    {data?.orgName && <span className="text-[11px] text-muted">{data.orgName}</span>}
                </div>
                <div className="flex items-center gap-2">
                    {/* Time range selector */}
                    {(["1d", "7d", "30d"] as TimeRange[]).map((r) => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            className="text-[10px] px-2 py-0.5 rounded"
                            style={{
                                background: range === r ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.05)",
                                color: range === r ? "#a78bfa" : "var(--secondary-text-color)",
                                border: range === r ? "1px solid rgba(167,139,250,0.3)" : "1px solid transparent",
                                cursor: "pointer",
                                fontWeight: range === r ? 600 : 400,
                            }}
                        >
                            {r}
                        </button>
                    ))}
                    <button
                        onClick={refresh}
                        className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                        title="Refresh"
                    >
                        <i className={`fa-sharp fa-solid fa-arrows-rotate ${loading ? "fa-spin" : ""}`} />
                    </button>
                </div>
            </div>

            {/* Scrollable content */}
            <div
                className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4"
                style={{ width: "100%", minWidth: 0 }}
            >
                {data?.error && (
                    <div
                        className="text-[11px] px-3 py-2 rounded"
                        style={{
                            background: "rgba(239,68,68,0.1)",
                            color: "#ef4444",
                            border: "1px solid rgba(239,68,68,0.2)",
                        }}
                    >
                        {data.error}
                    </div>
                )}

                {/* Summary Cards (hidden on error so a failed request doesn't read as $0.00) */}
                {data && !data.error && (
                    <div style={{ display: "flex", gap: 8 }}>
                        <SummaryCard label="Total Cost" value={formatCost(data.totalCostCents)} />
                        <SummaryCard
                            label="Input"
                            value={formatTokens(data.totalInputTokens)}
                            sub={`+ ${formatTokens(data.totalCacheReadTokens)} cached`}
                        />
                        <SummaryCard label="Output" value={formatTokens(data.totalOutputTokens)} />
                        <SummaryCard
                            label="Cache Hit"
                            value={cacheHitRate(data.totalCacheReadTokens, data.totalInputTokens)}
                        />
                    </div>
                )}

                {/* Daily cost bars */}
                {data && data.dailyCosts.length > 1 && <DailyBar costs={data.dailyCosts} maxCost={maxDailyCost} />}

                {/* Model breakdown */}
                {data && data.modelBreakdown.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: "var(--secondary-text-color)", flex: "2 1 0" }}
                            >
                                Model
                            </span>
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                            >
                                Input
                            </span>
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                            >
                                Output
                            </span>
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                            >
                                Cache
                            </span>
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wider"
                                style={{ color: "var(--secondary-text-color)", flex: "1 1 0", textAlign: "right" }}
                            >
                                Cost
                            </span>
                        </div>
                        {data.modelBreakdown.map((m, i) => (
                            <ModelRow key={m.model} model={m} maxCost={maxModelCost} colorIdx={i} />
                        ))}
                    </div>
                )}

                {/* Claude Code metrics — disabled: only tracks org API usage, not Max plan
                {data?.claudeCode && (
                    <ClaudeCodeSection metrics={data.claudeCode} />
                )}
                */}

                {/* Loading placeholder */}
                {loading && !data && (
                    <div className="flex items-center justify-center py-8">
                        <span className="text-[12px] text-muted">Loading usage data...</span>
                    </div>
                )}
            </div>
        </div>
    );
};

export { UsageViewModel };
