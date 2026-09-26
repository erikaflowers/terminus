// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { getGithubOrg, getRemoteConfig, getRepoBasePath, getTmuxCmd } from "@/app/store/agents";
import { getApi, WOS } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { isSafeSessionName, shellJoin, shellQuote, sshCommand } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Types ---

type FleetEntry = {
    agent_name: string;
    session_id: string | null;
    timestamp: string; // ISO 8601 UTC
    summary: string;
    last_commit_hash: string | null;
    last_commit_msg: string | null;
    project_dir: string | null;
};

type ConversationMessage = {
    session_id: string;
    agent_name: string;
    role: string; // "user" | "assistant"
    content: string;
    timestamp: string;
    sequence: number;
};

type ViewMode = "agent" | "user" | "search";

type SearchResult = {
    session_id: string;
    agent_name: string;
    role: string;
    content: string;
    timestamp: string;
    sequence: number;
};

type ChainTarget = {
    sessionId: string;
    agentName: string;
} | null;

type UserViewEntry = {
    sessionId: string;
    agentName: string;
    userContent: string;
    userTimestamp: string;
    assistantContent: string | null;
    assistantTimestamp: string | null;
};

// --- Constants ---

const DB_PATH = "~/.claude/hooks/fleet-log.db";
const POLL_INTERVAL = 30000;
const MAX_ENTRIES = 50;
const SUMMARY_LINE_LIMIT = 3;

// Agent colors — mirrored from agents.ts to avoid import dependencies
const AGENT_COLORS: Record<string, string> = {
    julian: "#6366F1",
    heavy: "#22C55E",
    decker: "#F59E0B",
    sellivan: "#8B5CF6",
    qin: "#EF4444",
    lee: "#06B6D4",
    manu: "#F97316",
    eliza: "#EC4899",
    adoni: "#A855F7",
    siddig: "#14B8A6",
    renner: "#84CC16",
    clarke: "#64748B",
    kogan: "#D946EF",
    reed: "#0EA5E9",
    renic: "#78716C",
    samantha: "#FF00FF",
};

const FALLBACK_COLOR = "#94a3b8";

function agentColor(name: string): string {
    return AGENT_COLORS[name.toLowerCase()] || FALLBACK_COLOR;
}

// --- Time Formatting ---

function formatRelativeTime(isoUtc: string): string {
    const then = new Date(isoUtc);
    const now = new Date();
    const diffMs = now.getTime() - then.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} min ago`;
    if (diffHr < 24) {
        // Show time today: "2:31 PM"
        return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    if (diffDay === 1) {
        return "Yesterday " + then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    if (diffDay < 7) {
        const day = then.toLocaleDateString(undefined, { weekday: "short" });
        const time = then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        return `${day} ${time}`;
    }
    return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- GitHub Link Derivation ---

function deriveCommitUrl(projectDir: string | null, hash: string): string | null {
    if (!projectDir || !hash) return null;
    const org = getGithubOrg();
    const basePath = getRepoBasePath();
    if (!org || !basePath) return null;
    // Extract repo name from project_dir relative to base path
    // e.g. "/Users/erik/projects/myrepo/subfolder" → "myrepo"
    const suffix = projectDir.startsWith(basePath) ? projectDir.slice(basePath.length) : null;
    if (!suffix) return null;
    const parts = suffix.replace(/^\//, "").split("/");
    const repo = parts[0];
    if (!repo) return null;
    return `https://github.com/${org}/${repo}/commit/${hash}`;
}

// --- Data Fetching ---

// SQL string literal (values come from the DB, so escape quotes rather than trusting them)
function sqlString(value: string): string {
    return "'" + String(value ?? "").replace(/'/g, "''") + "'";
}

const FLEET_QUERY = `SELECT agent_name, session_id, timestamp, summary, last_commit_hash, last_commit_msg, project_dir FROM agent_logs ORDER BY id DESC LIMIT ${MAX_ENTRIES};`;

async function fetchFleetEntries(): Promise<FleetEntry[]> {
    const cmd = `/usr/bin/sqlite3 -json ${DB_PATH} ${shellQuote(FLEET_QUERY)}`;
    const result = await getApi().execCommand(cmd);
    if (!result.stdout || result.stdout.trim() === "") return [];
    try {
        return JSON.parse(result.stdout);
    } catch (e) {
        console.error("[fleetlog] Failed to parse sqlite output:", e, result.stdout?.slice(0, 200));
        return [];
    }
}

async function fetchPrecedingUserMessage(
    sessionId: string,
    agentTimestamp: string
): Promise<ConversationMessage | null> {
    // Get the most recent user message before this agent log's timestamp
    const query = `SELECT session_id, agent_name, role, content, timestamp, sequence FROM conversation_messages WHERE session_id=${sqlString(sessionId)} AND role='user' AND timestamp <= ${sqlString(agentTimestamp)} ORDER BY sequence DESC LIMIT 1;`;
    const cmd = `/usr/bin/sqlite3 -json ${DB_PATH} ${shellQuote(query)}`;
    const result = await getApi().execCommand(cmd);
    if (!result.stdout || result.stdout.trim() === "") return null;
    try {
        const rows = JSON.parse(result.stdout);
        return rows.length > 0 ? rows[0] : null;
    } catch (e) {
        console.error("[fleetlog] Failed to parse preceding message:", e);
        return null;
    }
}

async function fetchFullConversation(sessionId: string): Promise<ConversationMessage[]> {
    const query = `SELECT session_id, agent_name, role, content, timestamp, sequence FROM conversation_messages WHERE session_id=${sqlString(sessionId)} ORDER BY sequence DESC;`;
    const cmd = `/usr/bin/sqlite3 -json ${DB_PATH} ${shellQuote(query)}`;
    const result = await getApi().execCommand(cmd);
    if (!result.stdout || result.stdout.trim() === "") return [];
    try {
        return JSON.parse(result.stdout);
    } catch (e) {
        console.error("[fleetlog] Failed to parse full conversation:", e);
        return [];
    }
}

async function fetchUserViewMessages(): Promise<UserViewEntry[]> {
    // Get all user messages paired with the next assistant response
    const query = `SELECT u.session_id, u.agent_name, u.content as user_content, u.timestamp as user_timestamp, u.sequence as user_seq, a.content as assistant_content, a.timestamp as assistant_timestamp FROM conversation_messages u LEFT JOIN conversation_messages a ON a.session_id = u.session_id AND a.sequence = u.sequence + 1 AND a.role = 'assistant' WHERE u.role = 'user' ORDER BY u.timestamp DESC LIMIT ${MAX_ENTRIES};`;
    const cmd = `/usr/bin/sqlite3 -json ${DB_PATH} ${shellQuote(query)}`;
    const result = await getApi().execCommand(cmd);
    if (!result.stdout || result.stdout.trim() === "") return [];
    try {
        const rows = JSON.parse(result.stdout);
        return rows.map((r: any) => ({
            sessionId: r.session_id,
            agentName: r.agent_name,
            userContent: r.user_content,
            userTimestamp: r.user_timestamp,
            assistantContent: r.assistant_content || null,
            assistantTimestamp: r.assistant_timestamp || null,
        }));
    } catch (e) {
        console.error("[fleetlog] Failed to parse user view:", e);
        return [];
    }
}

async function searchConversations(searchText: string): Promise<SearchResult[]> {
    if (!searchText.trim()) return [];
    const safeFull = searchText.trim().replace(/'/g, "''");
    const words = searchText.trim().split(/\s+/).filter(Boolean);

    // Build WHERE for conversation_messages (content column)
    const phraseClause = `content LIKE '%${safeFull}%'`;
    let convWhere: string;
    if (words.length > 1) {
        const wordClauses = words.map((w) => `content LIKE '%${w.replace(/'/g, "''")}%'`);
        convWhere = `(${phraseClause}) OR (${wordClauses.join(" AND ")})`;
    } else {
        convWhere = phraseClause;
    }

    // Build WHERE for agent_logs (summary column)
    const agentPhraseClause = `summary LIKE '%${safeFull}%'`;
    let agentWhere: string;
    if (words.length > 1) {
        const agentWordClauses = words.map((w) => `summary LIKE '%${w.replace(/'/g, "''")}%'`);
        agentWhere = `(${agentPhraseClause}) OR (${agentWordClauses.join(" AND ")})`;
    } else {
        agentWhere = agentPhraseClause;
    }

    // UNION both tables — conversation_messages + agent_logs summaries
    const query = `SELECT session_id, agent_name, role, content, timestamp, sequence FROM conversation_messages WHERE ${convWhere} UNION ALL SELECT session_id, agent_name, 'assistant' as role, summary as content, timestamp, 0 as sequence FROM agent_logs WHERE ${agentWhere} ORDER BY timestamp DESC LIMIT ${MAX_ENTRIES * 2};`;
    const cmd = `/usr/bin/sqlite3 -json ${DB_PATH} ${shellQuote(query)}`;
    const result = await getApi().execCommand(cmd);
    if (!result.stdout || result.stdout.trim() === "") return [];
    try {
        const rows: SearchResult[] = JSON.parse(result.stdout);
        // Dedup: prefer conversation_messages (has sequence > 0) over agent_logs (sequence = 0)
        // Key on first 100 chars of content + agent_name + close timestamp to catch overlaps
        const seen = new Set<string>();
        const deduped: SearchResult[] = [];
        for (const row of rows) {
            const key = `${row.agent_name}:${row.content.slice(0, 100)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(row);
            if (deduped.length >= MAX_ENTRIES) break;
        }
        return deduped;
    } catch (e) {
        console.error("[fleetlog] Failed to parse search results:", e);
        return [];
    }
}

// --- Send Reply to Agent ---

async function sendReplyToAgent(agentName: string, text: string): Promise<{ ok: boolean; error?: string }> {
    // agent_name comes from the fleet-log DB: never put an unvalidated one in a command
    if (!isSafeSessionName(agentName)) {
        console.warn("[fleetlog] refusing unsafe agent/session name", JSON.stringify(agentName));
        return { ok: false, error: "invalid agent name" };
    }
    const remote = getRemoteConfig();
    const tmux = getTmuxCmd();
    const pasteAndSubmit =
        shellJoin([tmux, "paste-buffer", "-t", agentName]) +
        " && sleep 0.1 && " +
        shellJoin([tmux, "send-keys", "-t", agentName, "Enter"]);

    let cmd: string;
    if (remote?.remoteHost) {
        // Base64 encode to avoid shell escaping issues over SSH (`base64 -d` works on macOS and GNU)
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(bin);
        const tmuxChain =
            `printf '%s' ${shellQuote(b64)} | base64 -d | ${shellJoin([tmux, "load-buffer", "-"])} && ` +
            pasteAndSubmit;
        cmd = sshCommand(remote.remoteHost, ["sh", "-c", tmuxChain]);
    } else {
        cmd = shellJoin([tmux, "set-buffer", "--", text]) + " && " + pasteAndSubmit;
    }

    const result = await getApi().execCommand(cmd);
    if (result.code !== 0) {
        return { ok: false, error: result.stderr || "Failed to send" };
    }
    return { ok: true };
}

// --- ViewModel ---

class FleetLogViewModel implements ViewModel {
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
        this.viewType = "fleetlog";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("satellite-dish");
        this.viewName = jotai.atom("Fleet");
        this.viewComponent = FleetLogView;
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- Shared Reply Composer ---

const ReplyComposer = React.memo(
    ({
        agentName,
        quotedSnippet,
        quoteLabel,
        onClose,
    }: {
        agentName: string;
        quotedSnippet: string;
        quoteLabel: string;
        onClose: () => void;
    }) => {
        const [replyText, setReplyText] = React.useState("");
        const [sending, setSending] = React.useState(false);
        const [sendResult, setSendResult] = React.useState<string | null>(null);
        const textareaRef = React.useRef<HTMLTextAreaElement>(null);
        const color = agentColor(agentName);

        React.useEffect(() => {
            setTimeout(() => textareaRef.current?.focus(), 50);
        }, []);

        const quotePrefix = `You said ${quoteLabel}:\n> ${quotedSnippet.split("\n").join("\n> ")}\n\n`;

        const handleSend = React.useCallback(async () => {
            if (!replyText.trim()) return;
            setSending(true);
            setSendResult(null);
            const fullMessage = quotePrefix + replyText.trim();
            const result = await sendReplyToAgent(agentName, fullMessage);
            setSending(false);
            if (result.ok) {
                setSendResult("sent");
                setReplyText("");
                setTimeout(() => {
                    onClose();
                }, 1500);
            } else {
                setSendResult(result.error || "failed");
            }
        }, [replyText, quotePrefix, agentName, onClose]);

        const handleKeyDown = React.useCallback(
            (e: React.KeyboardEvent) => {
                if (e.key === "Enter" && e.metaKey) {
                    e.preventDefault();
                    handleSend();
                }
                if (e.key === "Escape") {
                    onClose();
                }
            },
            [handleSend, onClose]
        );

        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: "8px 10px",
                    borderRadius: 5,
                    background: "rgba(99,102,241,0.06)",
                    border: "1px solid rgba(99,102,241,0.15)",
                    marginTop: 2,
                }}
            >
                <div
                    className="text-[9px]"
                    style={{
                        color: "var(--secondary-text-color)",
                        opacity: 0.6,
                        whiteSpace: "pre-wrap",
                        maxHeight: 60,
                        overflow: "hidden",
                        lineHeight: 1.4,
                        borderLeft: `2px solid ${color}40`,
                        paddingLeft: 6,
                    }}
                >
                    Quoting {agentName}: {quotedSnippet.slice(0, 120)}
                    {quotedSnippet.length > 120 ? "..." : ""}
                </div>
                <textarea
                    ref={textareaRef}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Reply to ${agentName}...`}
                    rows={3}
                    className="text-[11px]"
                    style={{
                        width: "100%",
                        background: "rgba(0,0,0,0.2)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 4,
                        padding: "6px 8px",
                        color: "var(--main-text-color)",
                        resize: "vertical",
                        outline: "none",
                        fontFamily: "inherit",
                        lineHeight: 1.5,
                    }}
                />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span className="text-[9px]" style={{ color: "var(--secondary-text-color)", opacity: 0.4 }}>
                        Cmd+Enter to send · Esc to cancel
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {sendResult === "sent" && (
                            <span className="text-[9px] font-semibold" style={{ color: "#22C55E" }}>
                                Sent!
                            </span>
                        )}
                        {sendResult && sendResult !== "sent" && (
                            <span className="text-[9px]" style={{ color: "#EF4444" }}>
                                {sendResult}
                            </span>
                        )}
                        <button
                            onClick={onClose}
                            className="text-[9px]"
                            style={{
                                background: "none",
                                border: "none",
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                padding: "2px 6px",
                                opacity: 0.6,
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSend}
                            disabled={sending || !replyText.trim()}
                            className="text-[9px] font-semibold"
                            style={{
                                background: sending ? "rgba(99,102,241,0.2)" : "rgba(99,102,241,0.3)",
                                border: "1px solid rgba(99,102,241,0.3)",
                                borderRadius: 4,
                                color: sending ? "var(--secondary-text-color)" : "#818CF8",
                                cursor: sending || !replyText.trim() ? "default" : "pointer",
                                padding: "3px 10px",
                                opacity: !replyText.trim() ? 0.4 : 1,
                            }}
                        >
                            {sending ? "Sending..." : "Send"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }
);
ReplyComposer.displayName = "ReplyComposer";

// --- Components ---

const CommitBadge = React.memo(
    ({ hash, commitMsg, projectDir }: { hash: string; commitMsg: string | null; projectDir: string | null }) => {
        const url = deriveCommitUrl(projectDir, hash);
        const shortHash = hash.slice(0, 7);

        const badge = (
            <span
                className="text-[10px] font-mono"
                style={{
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "var(--secondary-text-color)",
                    cursor: url ? "pointer" : "default",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                }}
                title={commitMsg || shortHash}
            >
                {shortHash}
                {commitMsg && (
                    <span style={{ fontFamily: "inherit", opacity: 0.7, maxWidth: 200 }} className="truncate">
                        {commitMsg}
                    </span>
                )}
                {url && (
                    <i
                        className="fa-sharp fa-solid fa-arrow-up-right-from-square"
                        style={{ fontSize: 8, opacity: 0.5 }}
                    />
                )}
            </span>
        );

        if (url) {
            return (
                <span onClick={() => getApi().openExternal(url)} style={{ cursor: "pointer" }}>
                    {badge}
                </span>
            );
        }
        return badge;
    }
);
CommitBadge.displayName = "CommitBadge";

// --- Preceding User Message (shown inside Agent View cards) ---

const PrecedingUserMessage = React.memo(
    ({ sessionId, agentTimestamp }: { sessionId: string; agentTimestamp: string }) => {
        const [msg, setMsg] = React.useState<ConversationMessage | null>(null);
        const [loading, setLoading] = React.useState(true);
        const [msgExpanded, setMsgExpanded] = React.useState(false);

        React.useEffect(() => {
            let cancelled = false;
            setLoading(true);
            fetchPrecedingUserMessage(sessionId, agentTimestamp).then((m) => {
                if (!cancelled) {
                    setMsg(m);
                    setLoading(false);
                }
            });
            return () => {
                cancelled = true;
            };
        }, [sessionId, agentTimestamp]);

        if (loading) {
            return (
                <div className="text-[10px] text-muted" style={{ padding: "6px 0", opacity: 0.5 }}>
                    Loading...
                </div>
            );
        }

        if (!msg) {
            return (
                <div className="text-[10px] text-muted" style={{ padding: "6px 0", opacity: 0.5 }}>
                    No preceding user message found.
                </div>
            );
        }

        const lines = msg.content.split("\n");
        const needsTrunc = lines.length > 6;
        const displayText = msgExpanded ? msg.content : lines.slice(0, 6).join("\n");

        return (
            <div
                style={{
                    padding: "6px 10px",
                    borderRadius: 5,
                    background: "rgba(99,102,241,0.08)",
                    borderLeft: "2px solid rgba(99,102,241,0.4)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    marginTop: 2,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span className="text-[9px] font-bold uppercase" style={{ color: "#6366F1", opacity: 0.7 }}>
                        You
                    </span>
                    <span className="text-[9px]" style={{ color: "var(--secondary-text-color)", opacity: 0.5 }}>
                        {formatRelativeTime(msg.timestamp)}
                    </span>
                </div>
                <div
                    className="text-[10px]"
                    style={{
                        color: "var(--main-text-color)",
                        opacity: 0.8,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.45,
                    }}
                >
                    {displayText}
                    {needsTrunc && !msgExpanded && (
                        <span
                            onClick={() => setMsgExpanded(true)}
                            className="text-[9px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.6,
                            }}
                        >
                            ...more
                        </span>
                    )}
                    {msgExpanded && needsTrunc && (
                        <span
                            onClick={() => setMsgExpanded(false)}
                            className="text-[9px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.6,
                            }}
                        >
                            less
                        </span>
                    )}
                </div>
            </div>
        );
    }
);
PrecedingUserMessage.displayName = "PrecedingUserMessage";

// --- Fleet Entry Card (Agent View) ---

const FleetEntryCard = React.memo(
    ({ entry, onOpenChain }: { entry: FleetEntry; onOpenChain: (sessionId: string, agentName: string) => void }) => {
        const [expanded, setExpanded] = React.useState(false);
        const [showConvo, setShowConvo] = React.useState(false);
        const [showReply, setShowReply] = React.useState(false);
        const color = agentColor(entry.agent_name);

        // Determine if summary needs truncation
        const lines = entry.summary.split("\n");
        const needsTruncation = lines.length > SUMMARY_LINE_LIMIT;
        const displayText = expanded ? entry.summary : lines.slice(0, SUMMARY_LINE_LIMIT).join("\n");
        const hasMore = needsTruncation && !expanded;

        const hasSession = !!entry.session_id;

        return (
            <div
                style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.02)",
                    borderLeft: `3px solid ${color}`,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                }}
            >
                {/* Header: agent name + timestamp + disclosure arrow */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {hasSession && (
                            <span
                                onClick={() => setShowConvo(!showConvo)}
                                style={{
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 14,
                                    height: 14,
                                    flexShrink: 0,
                                    transition: "transform 0.15s",
                                    transform: showConvo ? "rotate(90deg)" : "rotate(0deg)",
                                }}
                            >
                                <i
                                    className="fa-sharp fa-solid fa-caret-right"
                                    style={{ fontSize: 9, color: "var(--secondary-text-color)", opacity: 0.6 }}
                                />
                            </span>
                        )}
                        <span
                            style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: color,
                                display: "inline-block",
                                flexShrink: 0,
                            }}
                        />
                        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
                            {entry.agent_name}
                        </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!showReply && (
                            <span
                                onClick={() => setShowReply(true)}
                                className="text-[9px]"
                                style={{
                                    color: "var(--secondary-text-color)",
                                    cursor: "pointer",
                                    opacity: 0.5,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 3,
                                }}
                            >
                                <i className="fa-sharp fa-solid fa-reply" style={{ fontSize: 8 }} />
                                reply
                            </span>
                        )}
                        <span className="text-[10px]" style={{ color: "var(--secondary-text-color)", flexShrink: 0 }}>
                            {formatRelativeTime(entry.timestamp)}
                        </span>
                    </div>
                </div>

                {/* Summary */}
                <div
                    className="text-[11px]"
                    style={{
                        color: "var(--main-text-color)",
                        opacity: 0.85,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                    }}
                >
                    {displayText}
                    {hasMore && (
                        <span
                            onClick={() => setExpanded(true)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            ...show more
                        </span>
                    )}
                    {expanded && needsTruncation && (
                        <span
                            onClick={() => setExpanded(false)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                display: "inline-block",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            show less
                        </span>
                    )}
                </div>

                {/* Commit badge */}
                {entry.last_commit_hash && (
                    <div>
                        <CommitBadge
                            hash={entry.last_commit_hash}
                            commitMsg={entry.last_commit_msg}
                            projectDir={entry.project_dir}
                        />
                    </div>
                )}

                {/* Reply composer */}
                {showReply && (
                    <ReplyComposer
                        agentName={entry.agent_name}
                        quotedSnippet={entry.summary.length > 300 ? entry.summary.slice(0, 300) + "..." : entry.summary}
                        quoteLabel={entry.session_id ? `[session ${entry.session_id}]` : ""}
                        onClose={() => setShowReply(false)}
                    />
                )}

                {/* Preceding user message — lazy loaded on disclosure */}
                {showConvo && entry.session_id && (
                    <PrecedingUserMessage sessionId={entry.session_id} agentTimestamp={entry.timestamp} />
                )}

                {/* Full chain link */}
                {hasSession && (
                    <span
                        onClick={() => onOpenChain(entry.session_id!, entry.agent_name)}
                        className="text-[9px]"
                        style={{
                            color: "var(--secondary-text-color)",
                            cursor: "pointer",
                            opacity: 0.5,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            alignSelf: "flex-start",
                        }}
                    >
                        <i className="fa-sharp fa-solid fa-messages" style={{ fontSize: 8 }} />
                        full conversation
                    </span>
                )}
            </div>
        );
    }
);
FleetEntryCard.displayName = "FleetEntryCard";

const AgentFilterChip = React.memo(
    ({ name, active, count, onToggle }: { name: string; active: boolean; count: number; onToggle: () => void }) => {
        const color = agentColor(name);
        return (
            <button
                onClick={onToggle}
                className="text-[10px] font-semibold uppercase"
                style={{
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: active ? `${color}20` : "rgba(255,255,255,0.04)",
                    color: active ? color : "var(--secondary-text-color)",
                    border: active ? `1px solid ${color}40` : "1px solid transparent",
                    cursor: "pointer",
                    opacity: active ? 1 : 0.5,
                    transition: "all 0.15s",
                }}
            >
                {name} <span style={{ opacity: 0.6 }}>{count}</span>
            </button>
        );
    }
);
AgentFilterChip.displayName = "AgentFilterChip";

// --- User View Components ---

const UserMessageCard = React.memo(
    ({ entry, onOpenChain }: { entry: UserViewEntry; onOpenChain: (sessionId: string, agentName: string) => void }) => {
        const color = agentColor(entry.agentName);
        const [showAgentReply, setShowAgentReply] = React.useState(false);
        const [showReplyComposer, setShowReplyComposer] = React.useState(false);
        const [msgExpanded, setMsgExpanded] = React.useState(false);

        const userLines = entry.userContent.split("\n");
        const needsTrunc = userLines.length > SUMMARY_LINE_LIMIT;
        const displayText = msgExpanded ? entry.userContent : userLines.slice(0, SUMMARY_LINE_LIMIT).join("\n");

        return (
            <div
                style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.02)",
                    borderLeft: "3px solid #6366F1",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                }}
            >
                {/* Header: "You → agent" + reply + timestamp */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {entry.assistantContent && (
                            <span
                                onClick={() => setShowAgentReply(!showAgentReply)}
                                style={{
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 14,
                                    height: 14,
                                    flexShrink: 0,
                                    transition: "transform 0.15s",
                                    transform: showAgentReply ? "rotate(90deg)" : "rotate(0deg)",
                                }}
                            >
                                <i
                                    className="fa-sharp fa-solid fa-caret-right"
                                    style={{ fontSize: 9, color: "var(--secondary-text-color)", opacity: 0.6 }}
                                />
                            </span>
                        )}
                        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "#6366F1" }}>
                            You
                        </span>
                        <i
                            className="fa-sharp fa-solid fa-arrow-right"
                            style={{ fontSize: 8, color: "var(--secondary-text-color)", opacity: 0.4 }}
                        />
                        <span
                            style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: color,
                                display: "inline-block",
                                flexShrink: 0,
                            }}
                        />
                        <span className="text-[10px] font-semibold uppercase" style={{ color, opacity: 0.8 }}>
                            {entry.agentName}
                        </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!showReplyComposer && (
                            <span
                                onClick={() => setShowReplyComposer(true)}
                                className="text-[9px]"
                                style={{
                                    color: "var(--secondary-text-color)",
                                    cursor: "pointer",
                                    opacity: 0.5,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 3,
                                }}
                            >
                                <i className="fa-sharp fa-solid fa-reply" style={{ fontSize: 8 }} />
                                reply
                            </span>
                        )}
                        <span className="text-[10px]" style={{ color: "var(--secondary-text-color)", flexShrink: 0 }}>
                            {formatRelativeTime(entry.userTimestamp)}
                        </span>
                    </div>
                </div>

                {/* User message content */}
                <div
                    className="text-[11px]"
                    style={{
                        color: "var(--main-text-color)",
                        opacity: 0.85,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                    }}
                >
                    {displayText}
                    {needsTrunc && !msgExpanded && (
                        <span
                            onClick={() => setMsgExpanded(true)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            ...show more
                        </span>
                    )}
                    {msgExpanded && needsTrunc && (
                        <span
                            onClick={() => setMsgExpanded(false)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                display: "inline-block",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            show less
                        </span>
                    )}
                </div>

                {/* Agent reply — disclosed on click */}
                {showAgentReply && entry.assistantContent && (
                    <AgentReplyBlock
                        agentName={entry.agentName}
                        content={entry.assistantContent}
                        timestamp={entry.assistantTimestamp}
                    />
                )}

                {/* Reply composer */}
                {showReplyComposer && (
                    <ReplyComposer
                        agentName={entry.agentName}
                        quotedSnippet={
                            entry.userContent.length > 300 ? entry.userContent.slice(0, 300) + "..." : entry.userContent
                        }
                        quoteLabel={`[session ${entry.sessionId}]`}
                        onClose={() => setShowReplyComposer(false)}
                    />
                )}

                {/* Full chain link */}
                <span
                    onClick={() => onOpenChain(entry.sessionId, entry.agentName)}
                    className="text-[9px]"
                    style={{
                        color: "var(--secondary-text-color)",
                        cursor: "pointer",
                        opacity: 0.5,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        alignSelf: "flex-start",
                    }}
                >
                    <i className="fa-sharp fa-solid fa-messages" style={{ fontSize: 8 }} />
                    full conversation
                </span>
            </div>
        );
    }
);
UserMessageCard.displayName = "UserMessageCard";

const AgentReplyBlock = React.memo(
    ({ agentName, content, timestamp }: { agentName: string; content: string; timestamp: string | null }) => {
        const color = agentColor(agentName);
        const [replyExpanded, setReplyExpanded] = React.useState(false);
        const lines = content.split("\n");
        const needsTrunc = lines.length > 6;
        const displayText = replyExpanded ? content : lines.slice(0, 6).join("\n");

        return (
            <div
                style={{
                    padding: "6px 10px",
                    borderRadius: 5,
                    background: "rgba(255,255,255,0.03)",
                    borderLeft: `2px solid ${color}40`,
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span className="text-[9px] font-bold uppercase" style={{ color, opacity: 0.7 }}>
                        {agentName}
                    </span>
                    {timestamp && (
                        <span className="text-[9px]" style={{ color: "var(--secondary-text-color)", opacity: 0.5 }}>
                            {formatRelativeTime(timestamp)}
                        </span>
                    )}
                </div>
                <div
                    className="text-[10px]"
                    style={{
                        color: "var(--main-text-color)",
                        opacity: 0.75,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.45,
                    }}
                >
                    {displayText}
                    {needsTrunc && !replyExpanded && (
                        <span
                            onClick={() => setReplyExpanded(true)}
                            className="text-[9px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.6,
                            }}
                        >
                            ...more
                        </span>
                    )}
                    {replyExpanded && needsTrunc && (
                        <span
                            onClick={() => setReplyExpanded(false)}
                            className="text-[9px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.6,
                            }}
                        >
                            less
                        </span>
                    )}
                </div>
            </div>
        );
    }
);
AgentReplyBlock.displayName = "AgentReplyBlock";

// --- Search Result Card ---

const SearchResultCard = React.memo(
    ({
        result,
        searchTerms,
        onOpenChain,
    }: {
        result: SearchResult;
        searchTerms: string[];
        onOpenChain: (sessionId: string, agentName: string) => void;
    }) => {
        const isUser = result.role === "user";
        const color = isUser ? "#6366F1" : agentColor(result.agent_name);
        const [showReply, setShowReply] = React.useState(false);
        const [msgExpanded, setMsgExpanded] = React.useState(false);

        const lines = result.content.split("\n");
        const needsTrunc = lines.length > SUMMARY_LINE_LIMIT;
        const displayText = msgExpanded ? result.content : lines.slice(0, SUMMARY_LINE_LIMIT).join("\n");

        // Highlight matching terms in the displayed text
        const highlightText = React.useMemo(() => {
            if (searchTerms.length === 0) return [displayText];
            // Build a regex that matches any of the search terms (case-insensitive)
            const escaped = searchTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const regex = new RegExp(`(${escaped.join("|")})`, "gi");
            const parts = displayText.split(regex);
            return parts;
        }, [displayText, searchTerms]);

        return (
            <div
                style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.02)",
                    borderLeft: `3px solid ${color}`,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                }}
            >
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                            style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: color,
                                display: "inline-block",
                                flexShrink: 0,
                            }}
                        />
                        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
                            {isUser ? "You" : result.agent_name}
                        </span>
                        <span
                            className="text-[9px]"
                            style={{
                                padding: "0 5px",
                                borderRadius: 3,
                                background: isUser ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.06)",
                                color: "var(--secondary-text-color)",
                                opacity: 0.7,
                            }}
                        >
                            {isUser ? "user" : "assistant"}
                        </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!isUser && !showReply && (
                            <span
                                onClick={() => setShowReply(true)}
                                className="text-[9px]"
                                style={{
                                    color: "var(--secondary-text-color)",
                                    cursor: "pointer",
                                    opacity: 0.5,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 3,
                                }}
                            >
                                <i className="fa-sharp fa-solid fa-reply" style={{ fontSize: 8 }} />
                                reply
                            </span>
                        )}
                        <span className="text-[10px]" style={{ color: "var(--secondary-text-color)", flexShrink: 0 }}>
                            {formatRelativeTime(result.timestamp)}
                        </span>
                    </div>
                </div>

                {/* Content with highlights */}
                <div
                    className="text-[11px]"
                    style={{
                        color: "var(--main-text-color)",
                        opacity: 0.85,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                    }}
                >
                    {highlightText.map((part, i) => {
                        const isMatch = searchTerms.some((t) => part.toLowerCase() === t.toLowerCase());
                        return isMatch ? (
                            <span
                                key={i}
                                style={{
                                    background: "rgba(250,204,21,0.25)",
                                    color: "#fbbf24",
                                    borderRadius: 2,
                                    padding: "0 1px",
                                }}
                            >
                                {part}
                            </span>
                        ) : (
                            <span key={i}>{part}</span>
                        );
                    })}
                    {needsTrunc && !msgExpanded && (
                        <span
                            onClick={() => setMsgExpanded(true)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            ...show more
                        </span>
                    )}
                    {msgExpanded && needsTrunc && (
                        <span
                            onClick={() => setMsgExpanded(false)}
                            className="text-[10px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                display: "inline-block",
                                marginLeft: 4,
                                opacity: 0.7,
                            }}
                        >
                            show less
                        </span>
                    )}
                </div>

                {/* Reply composer */}
                {showReply && (
                    <ReplyComposer
                        agentName={result.agent_name}
                        quotedSnippet={
                            result.content.length > 300 ? result.content.slice(0, 300) + "..." : result.content
                        }
                        quoteLabel={`[session ${result.session_id}, seq ${result.sequence}]`}
                        onClose={() => setShowReply(false)}
                    />
                )}

                {/* Full chain link */}
                <span
                    onClick={() => onOpenChain(result.session_id, result.agent_name)}
                    className="text-[9px]"
                    style={{
                        color: "var(--secondary-text-color)",
                        cursor: "pointer",
                        opacity: 0.5,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        alignSelf: "flex-start",
                    }}
                >
                    <i className="fa-sharp fa-solid fa-messages" style={{ fontSize: 8 }} />
                    full conversation
                </span>
            </div>
        );
    }
);
SearchResultCard.displayName = "SearchResultCard";

// --- Full Chain View (panel takeover) ---

const FullChainMessage = React.memo(({ msg }: { msg: ConversationMessage }) => {
    const isUser = msg.role === "user";
    const color = isUser ? "#6366F1" : agentColor(msg.agent_name);
    const [msgExpanded, setMsgExpanded] = React.useState(false);
    const [showReply, setShowReply] = React.useState(false);

    const lines = msg.content.split("\n");
    const needsTrunc = lines.length > 20;
    const displayText = msgExpanded ? msg.content : lines.slice(0, 20).join("\n");

    return (
        <div
            style={{
                padding: "10px 14px",
                borderRadius: 6,
                background: isUser ? "rgba(99,102,241,0.06)" : "rgba(255,255,255,0.02)",
                borderLeft: `3px solid ${color}`,
                display: "flex",
                flexDirection: "column",
                gap: 4,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color }}>
                    {isUser ? "You" : msg.agent_name}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {!isUser && !showReply && (
                        <span
                            onClick={() => setShowReply(true)}
                            className="text-[9px]"
                            style={{
                                color: "var(--secondary-text-color)",
                                cursor: "pointer",
                                opacity: 0.5,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                            }}
                        >
                            <i className="fa-sharp fa-solid fa-reply" style={{ fontSize: 8 }} />
                            reply
                        </span>
                    )}
                    <span className="text-[10px]" style={{ color: "var(--secondary-text-color)", opacity: 0.6 }}>
                        {formatRelativeTime(msg.timestamp)}
                    </span>
                </div>
            </div>
            <div
                className="text-[11px]"
                style={{
                    color: "var(--main-text-color)",
                    opacity: 0.85,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.55,
                }}
            >
                {displayText}
                {needsTrunc && !msgExpanded && (
                    <span
                        onClick={() => setMsgExpanded(true)}
                        className="text-[10px]"
                        style={{ color: "var(--secondary-text-color)", cursor: "pointer", marginLeft: 4, opacity: 0.7 }}
                    >
                        ...show more
                    </span>
                )}
                {msgExpanded && needsTrunc && (
                    <span
                        onClick={() => setMsgExpanded(false)}
                        className="text-[10px]"
                        style={{
                            color: "var(--secondary-text-color)",
                            cursor: "pointer",
                            display: "inline-block",
                            marginLeft: 4,
                            opacity: 0.7,
                        }}
                    >
                        show less
                    </span>
                )}
            </div>

            {/* Reply composer */}
            {showReply && (
                <ReplyComposer
                    agentName={msg.agent_name}
                    quotedSnippet={msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content}
                    quoteLabel={`[session ${msg.session_id}, seq ${msg.sequence}]`}
                    onClose={() => setShowReply(false)}
                />
            )}
        </div>
    );
});
FullChainMessage.displayName = "FullChainMessage";

const FullChainView = React.memo(
    ({ sessionId, agentName, onBack }: { sessionId: string; agentName: string; onBack: () => void }) => {
        const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
        const [loading, setLoading] = React.useState(true);
        const color = agentColor(agentName);

        React.useEffect(() => {
            let cancelled = false;
            setLoading(true);
            fetchFullConversation(sessionId).then((msgs) => {
                if (!cancelled) {
                    setMessages(msgs);
                    setLoading(false);
                }
            });
            return () => {
                cancelled = true;
            };
        }, [sessionId]);

        return (
            <div
                className="flex flex-col overflow-hidden"
                style={{ background: "var(--block-bg-color)", flex: "1 1 0", minWidth: 0, height: "100%" }}
            >
                {/* Chain header */}
                <div className="flex items-center gap-3 px-3 py-2 border-b border-white/10" style={{ width: "100%" }}>
                    <button
                        onClick={onBack}
                        className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                        title="Back to list"
                    >
                        <i className="fa-sharp fa-solid fa-arrow-left" style={{ fontSize: 10 }} />
                    </button>
                    <span
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: color,
                            display: "inline-block",
                            flexShrink: 0,
                        }}
                    />
                    <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color }}>
                        {agentName}
                    </span>
                    <span className="text-[10px] text-muted">
                        {loading ? "loading..." : `${messages.length} messages`}
                    </span>
                </div>

                {/* Scrollable conversation */}
                <div
                    className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2"
                    style={{ width: "100%", minWidth: 0 }}
                >
                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <span className="text-[11px] text-muted">Loading conversation...</span>
                        </div>
                    )}
                    {!loading && messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12" style={{ gap: 8 }}>
                            <i
                                className="fa-sharp fa-solid fa-comments"
                                style={{ fontSize: 20, color: "var(--secondary-text-color)", opacity: 0.4 }}
                            />
                            <span className="text-[12px] text-muted">No messages found for this session.</span>
                        </div>
                    )}
                    {messages.map((msg, i) => (
                        <FullChainMessage key={`${msg.session_id}-${msg.sequence}-${i}`} msg={msg} />
                    ))}
                </div>
            </div>
        );
    }
);
FullChainView.displayName = "FullChainView";

// --- View Mode Tab ---

const ViewModeTab = React.memo(
    ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => (
        <button
            onClick={onClick}
            className="text-[10px] font-semibold uppercase tracking-wide"
            style={{
                padding: "3px 10px",
                borderRadius: 4,
                background: active ? "rgba(255,255,255,0.1)" : "transparent",
                color: active ? "var(--main-text-color)" : "var(--secondary-text-color)",
                border: "none",
                cursor: "pointer",
                opacity: active ? 1 : 0.6,
                transition: "all 0.15s",
            }}
        >
            {label}
        </button>
    )
);
ViewModeTab.displayName = "ViewModeTab";

// --- Main View ---

const FleetLogView: React.FC<ViewComponentProps<FleetLogViewModel>> = ({ model }) => {
    const [entries, setEntries] = React.useState<FleetEntry[]>([]);
    const [userEntries, setUserEntries] = React.useState<UserViewEntry[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [activeAgents, setActiveAgents] = React.useState<Set<string> | null>(null); // null = show all
    const [viewMode, setViewMode] = React.useState<ViewMode>("agent");
    const [chainTarget, setChainTarget] = React.useState<ChainTarget>(null);
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
    const [searchLoading, setSearchLoading] = React.useState(false);
    const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounced search
    React.useEffect(() => {
        if (viewMode !== "search") return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }
        setSearchLoading(true);
        searchTimerRef.current = setTimeout(async () => {
            const results = await searchConversations(searchQuery);
            setSearchResults(results);
            setSearchLoading(false);
        }, 300);
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [searchQuery, viewMode]);

    const searchTerms = React.useMemo(() => {
        return searchQuery.trim().split(/\s+/).filter(Boolean);
    }, [searchQuery]);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        if (viewMode === "agent") {
            const data = await fetchFleetEntries();
            setEntries(data);
        } else if (viewMode === "user") {
            const data = await fetchUserViewMessages();
            setUserEntries(data);
        }
        setLoading(false);
    }, [viewMode]);

    React.useEffect(() => {
        refresh();
        const interval = setInterval(refresh, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [refresh]);

    // Compute agent counts (agent view only)
    const agentCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const e of entries) {
            counts.set(e.agent_name, (counts.get(e.agent_name) || 0) + 1);
        }
        return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    }, [entries]);

    // Filter entries (agent view)
    const filteredEntries = React.useMemo(() => {
        if (!activeAgents) return entries;
        return entries.filter((e) => activeAgents.has(e.agent_name));
    }, [entries, activeAgents]);

    // Filter user entries
    const filteredUserEntries = React.useMemo(() => {
        if (!activeAgents) return userEntries;
        return userEntries.filter((e) => activeAgents.has(e.agentName));
    }, [userEntries, activeAgents]);

    const handleToggleAgent = React.useCallback((name: string) => {
        setActiveAgents((prev) => {
            if (prev === null) {
                return new Set([name]);
            }
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
                return next.size === 0 ? null : next;
            } else {
                next.add(name);
                return next;
            }
        });
    }, []);

    const handleShowAll = React.useCallback(() => {
        setActiveAgents(null);
    }, []);

    const handleOpenChain = React.useCallback((sessionId: string, agentName: string) => {
        setChainTarget({ sessionId, agentName });
    }, []);

    const handleCloseChain = React.useCallback(() => {
        setChainTarget(null);
    }, []);

    // Agent counts for user view (for filter chips) — must be above early return
    const userAgentCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const e of userEntries) {
            counts.set(e.agentName, (counts.get(e.agentName) || 0) + 1);
        }
        return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    }, [userEntries]);

    // If chain view is active, take over the whole panel
    if (chainTarget) {
        return (
            <FullChainView
                sessionId={chainTarget.sessionId}
                agentName={chainTarget.agentName}
                onBack={handleCloseChain}
            />
        );
    }

    const displayCount =
        viewMode === "agent"
            ? filteredEntries.length
            : viewMode === "user"
              ? filteredUserEntries.length
              : searchResults.length;
    const chipCounts = viewMode === "agent" ? agentCounts : userAgentCounts;

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
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Fleet</span>
                    <span className="text-[11px] text-muted">{displayCount} entries</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <ViewModeTab label="Agents" active={viewMode === "agent"} onClick={() => setViewMode("agent")} />
                    <ViewModeTab label="My Messages" active={viewMode === "user"} onClick={() => setViewMode("user")} />
                    <ViewModeTab label="Search" active={viewMode === "search"} onClick={() => setViewMode("search")} />
                    {viewMode !== "search" && (
                        <button
                            onClick={refresh}
                            className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                            style={{
                                background: "rgba(255,255,255,0.05)",
                                cursor: "pointer",
                                border: "none",
                                marginLeft: 4,
                            }}
                            title="Refresh"
                        >
                            <i className={`fa-sharp fa-solid fa-arrows-rotate ${loading ? "fa-spin" : ""}`} />
                        </button>
                    )}
                </div>
            </div>

            {/* Search input */}
            {viewMode === "search" && (
                <div className="px-3 py-2 border-b border-white/10" style={{ width: "100%" }}>
                    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                        <i
                            className="fa-sharp fa-solid fa-magnifying-glass"
                            style={{
                                position: "absolute",
                                left: 8,
                                fontSize: 10,
                                color: "var(--secondary-text-color)",
                                opacity: 0.5,
                                pointerEvents: "none",
                            }}
                        />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search conversations..."
                            autoFocus
                            className="text-[11px]"
                            style={{
                                width: "100%",
                                background: "rgba(0,0,0,0.2)",
                                border: "1px solid rgba(255,255,255,0.1)",
                                borderRadius: 5,
                                padding: "6px 8px 6px 28px",
                                color: "var(--main-text-color)",
                                outline: "none",
                                fontFamily: "inherit",
                            }}
                        />
                        {searchLoading && (
                            <i
                                className="fa-sharp fa-solid fa-spinner fa-spin"
                                style={{
                                    position: "absolute",
                                    right: 8,
                                    fontSize: 10,
                                    color: "var(--secondary-text-color)",
                                    opacity: 0.5,
                                }}
                            />
                        )}
                    </div>
                </div>
            )}

            {/* Agent filter chips (agent + user views only) */}
            {viewMode !== "search" && chipCounts.length > 1 && (
                <div
                    className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 flex-wrap"
                    style={{ width: "100%" }}
                >
                    <button
                        onClick={handleShowAll}
                        className="text-[10px] font-semibold"
                        style={{
                            padding: "2px 8px",
                            borderRadius: 10,
                            background: activeAgents === null ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                            color: activeAgents === null ? "var(--main-text-color)" : "var(--secondary-text-color)",
                            border: "1px solid transparent",
                            cursor: "pointer",
                            opacity: activeAgents === null ? 1 : 0.5,
                        }}
                    >
                        ALL
                    </button>
                    {chipCounts.map(([name, count]) => (
                        <AgentFilterChip
                            key={name}
                            name={name}
                            count={count}
                            active={activeAgents === null || activeAgents.has(name)}
                            onToggle={() => handleToggleAgent(name)}
                        />
                    ))}
                </div>
            )}

            {/* Scrollable entry list */}
            <div
                className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2"
                style={{ width: "100%", minWidth: 0 }}
            >
                {viewMode === "agent" && (
                    <>
                        {filteredEntries.length === 0 && !loading && (
                            <div className="flex flex-col items-center justify-center py-12" style={{ gap: 8 }}>
                                <i
                                    className="fa-sharp fa-solid fa-satellite-dish"
                                    style={{ fontSize: 20, color: "var(--secondary-text-color)", opacity: 0.4 }}
                                />
                                <span className="text-[12px] text-muted">No fleet activity recorded yet.</span>
                            </div>
                        )}
                        {filteredEntries.map((entry, i) => (
                            <FleetEntryCard
                                key={`${entry.timestamp}-${entry.agent_name}-${i}`}
                                entry={entry}
                                onOpenChain={handleOpenChain}
                            />
                        ))}
                    </>
                )}
                {viewMode === "user" && (
                    <>
                        {filteredUserEntries.length === 0 && !loading && (
                            <div className="flex flex-col items-center justify-center py-12" style={{ gap: 8 }}>
                                <i
                                    className="fa-sharp fa-solid fa-user"
                                    style={{ fontSize: 20, color: "var(--secondary-text-color)", opacity: 0.4 }}
                                />
                                <span className="text-[12px] text-muted">No user messages recorded yet.</span>
                            </div>
                        )}
                        {filteredUserEntries.map((entry, i) => (
                            <UserMessageCard
                                key={`${entry.userTimestamp}-${entry.agentName}-${i}`}
                                entry={entry}
                                onOpenChain={handleOpenChain}
                            />
                        ))}
                    </>
                )}
                {viewMode === "search" && (
                    <>
                        {!searchQuery.trim() && (
                            <div className="flex flex-col items-center justify-center py-12" style={{ gap: 8 }}>
                                <i
                                    className="fa-sharp fa-solid fa-magnifying-glass"
                                    style={{ fontSize: 20, color: "var(--secondary-text-color)", opacity: 0.4 }}
                                />
                                <span className="text-[12px] text-muted">Type to search conversations...</span>
                            </div>
                        )}
                        {searchQuery.trim() && !searchLoading && searchResults.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-12" style={{ gap: 8 }}>
                                <i
                                    className="fa-sharp fa-solid fa-magnifying-glass"
                                    style={{ fontSize: 20, color: "var(--secondary-text-color)", opacity: 0.4 }}
                                />
                                <span className="text-[12px] text-muted">No results for "{searchQuery}"</span>
                            </div>
                        )}
                        {searchResults.map((result, i) => (
                            <SearchResultCard
                                key={`${result.session_id}-${result.sequence}-${i}`}
                                result={result}
                                searchTerms={searchTerms}
                                onOpenChain={handleOpenChain}
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
};

export { FleetLogViewModel };
