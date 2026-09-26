// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { buildTmuxCommand, getRemoteConfig, getTmuxCmd } from "@/app/store/agents";
import { getApi, WOS } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { isSafeSessionName, shellJoin, shellQuote, sshCommand } from "@/util/shellquote";
import * as jotai from "jotai";
import * as React from "react";

// --- Constants ---

// tmux path resolved dynamically via getTmuxCmd()

// Agent colors — mirrored from agents.ts
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
const SELECTED_COLOR = "#F5A623"; // bright gold/orange — universal "targeted" color
const QUEUE_COLOR = "#e879f9"; // fuchsia — queued/relay items
const DRAFTS_FILE = "hopper-drafts.json";
const MACROS_FILE = "hopper-macros.json";
const QUEUE_FILE = "hopper-queue.json";
// Agents append to the inbox (drop box); the Hopper consumes it atomically and moves regular
// messages into the kept file, which only the Hopper writes. Both live on the host the agents run
// on (the remote host in remote mode). Paths are used inside double quotes so $HOME expands.
const INBOX_PATH = "$HOME/.claude/hooks/hopper-inbox.jsonl";
const INBOX_KEPT_PATH = "$HOME/.claude/hooks/hopper-inbox.kept.jsonl";
// Append-only record of everything consumed (relay signals included), trimmed to the last
// INBOX_HISTORY_LINES lines. The visualizer panels read this, since the inbox itself is drained.
const INBOX_HISTORY_PATH = "$HOME/.claude/hooks/hopper-inbox.history.jsonl";
const INBOX_HISTORY_LINES = 500;

function agentColor(name: string): string {
    return AGENT_COLORS[name.toLowerCase()] || FALLBACK_COLOR;
}

// --- Types ---

type SessionInfo = {
    name: string;
    hasClaudeCode: boolean;
};

type Draft = {
    id: string;
    text: string;
    createdAt: string;
    label?: string;
};

type Macro = {
    id: string;
    name: string;
    text: string;
    targets?: string[];
};

type InboxMessage = {
    from: string;
    to?: string;
    msg?: string;
    signal?: string; // "relay" = fire next queued prompt
    payload?: string; // contextual data from previous agent, injected into next queued prompt
    ts: string;
};

type SendResult = {
    ok: boolean;
    agents: string[];
    failures: string[];
};

type QueuedPrompt = {
    id: string;
    targetAgent: string;
    text: string;
    createdAt: string;
    status: "waiting" | "sent";
    expectsPayload?: boolean; // if true, next relay should include a payload
    relayFrom?: string; // agent whose relay signal fires this prompt (set when that agent is sent the relay instruction)
};

// --- Relay Instruction ---

function buildRelayInstruction(fromAgent: string, nextExpectsPayload: boolean): string {
    if (nextExpectsPayload) {
        return (
            `\n\nOne more thing — after you finish, I need you to notify the Hopper so the next agent can pick up where you left off. ` +
            `Replace PAYLOAD_HERE with a short summary of what you found or built (endpoints, field names, whatever is relevant). ` +
            `Escape any single quotes with '\\''.\n\n` +
            `echo '{"from":"${fromAgent}","signal":"relay","payload":"PAYLOAD_HERE","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.claude/hooks/hopper-inbox.jsonl\n\n` +
            `This is part of our relay workflow — Samantha set it up so agents can hand off work to each other through the Hopper.`
        );
    }
    return (
        `\n\nOne more thing — after you finish, notify the Hopper so the next agent in the chain can start. Run this:\n\n` +
        `echo '{"from":"${fromAgent}","signal":"relay","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.claude/hooks/hopper-inbox.jsonl\n\n` +
        `This is part of our relay workflow — Samantha set it up so agents can hand off work to each other through the Hopper.`
    );
}

// --- Persistence Helpers ---

async function readJsonFile<T>(fileName: string): Promise<T | null> {
    const configDir = getApi().getConfigDir();
    const raw = await getApi().readTextFile(configDir + "/" + fileName);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

async function writeJsonFile<T>(fileName: string, data: T): Promise<void> {
    const configDir = getApi().getConfigDir();
    await getApi().writeTextFile(configDir + "/" + fileName, JSON.stringify(data, null, 2));
}

// Run a /bin/sh script on the host the agents live on (remote host in remote mode).
function hostShellCommand(script: string): string {
    const remote = getRemoteConfig();
    if (remote?.remoteHost) {
        return sshCommand(remote.remoteHost, ["sh", "-c", script]);
    }
    return script;
}

function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
}

// `base64 -d` decodes on both macOS and GNU coreutils
function base64DecodeCmd(text: string): string {
    return `printf '%s' ${shellQuote(toBase64(text))} | base64 -d`;
}

function parseInboxLines(stdout: string): InboxMessage[] {
    const messages: InboxMessage[] = [];
    for (const line of (stdout ?? "").split("\n")) {
        if (!line.trim()) continue;
        try {
            messages.push(JSON.parse(line));
        } catch {
            // skip malformed lines
        }
    }
    return messages;
}

// Atomically take everything agents have appended so far: after the mv, new appends go to a
// fresh inbox file, so nothing written between the read and the cleanup is lost.
async function consumeInbox(): Promise<InboxMessage[]> {
    const script =
        `f="${INBOX_PATH}"; c="$f.consume.$$"; h="${INBOX_HISTORY_PATH}"; ` +
        `[ -s "$f" ] || exit 0; mv "$f" "$c" && cat "$c" && cat "$c" >> "$h" && rm -f "$c"; ` +
        `tail -n ${INBOX_HISTORY_LINES} "$h" > "$h.tmp.$$" && mv "$h.tmp.$$" "$h"`;
    const result = await getApi().execCommand(hostShellCommand(script));
    return parseInboxLines(result.stdout);
}

// Messages the Hopper has kept for display (only the Hopper writes this file)
async function readKeptInbox(): Promise<InboxMessage[]> {
    const result = await getApi().execCommand(hostShellCommand(`cat "${INBOX_KEPT_PATH}" 2>/dev/null || true`));
    return parseInboxLines(result.stdout);
}

async function appendKeptInbox(messages: InboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const script = `mkdir -p "$HOME/.claude/hooks" && ${base64DecodeCmd(content)} >> "${INBOX_KEPT_PATH}"`;
    await getApi().execCommand(hostShellCommand(script));
}

// Remove the first line equal to this message from the CURRENT kept file (one read-modify-write
// in a single shell command). Kept lines are always written with JSON.stringify, so the
// re-serialized message matches its line exactly.
async function removeKeptInboxMessage(message: InboxMessage): Promise<void> {
    const line = JSON.stringify(message);
    const script =
        `k="${INBOX_KEPT_PATH}"; [ -f "$k" ] || exit 0; ` +
        `T="$(${base64DecodeCmd(line)})" && export T && ` +
        `awk 'BEGIN{t=ENVIRON["T"]} !done && $0==t {done=1; next} {print}' "$k" > "$k.tmp.$$" && ` +
        `mv "$k.tmp.$$" "$k"`;
    await getApi().execCommand(hostShellCommand(script));
}

// --- Data Fetching ---

async function fetchActiveSessions(): Promise<SessionInfo[]> {
    const listCmd = buildTmuxCommand(["list-sessions", "-F", "#{session_name}"]) + " 2>/dev/null";

    const result = await getApi().execCommand(listCmd);
    if (!result.stdout) return [];

    // session names come from the (possibly remote) host: never put an unvalidated one in a command
    const sessionNames = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((name) => {
            if (isSafeSessionName(name)) return true;
            console.warn("[hopper] skipping unsafe tmux session name", JSON.stringify(name));
            return false;
        });

    const checks = await Promise.all(
        sessionNames.map(async (name) => {
            const paneCmd =
                buildTmuxCommand(["list-panes", "-t", name, "-F", "#{pane_current_command}"]) + " 2>/dev/null";
            const cmdResult = await getApi().execCommand(paneCmd);
            const cmd = cmdResult.stdout?.trim() || "";
            return { name, hasClaudeCode: cmd === "node" };
        })
    );

    return checks;
}

// --- Send to Agent ---

async function sendToAgent(
    sessionName: string,
    text: string,
    autoSubmit: boolean
): Promise<{ ok: boolean; error?: string }> {
    if (!isSafeSessionName(sessionName)) {
        console.warn("[hopper] refusing unsafe session name", JSON.stringify(sessionName));
        return { ok: false, error: "invalid session name" };
    }
    const remote = getRemoteConfig();
    const tmux = getTmuxCmd();

    let cmd: string;
    if (remote?.remoteHost) {
        // Base64 encode to avoid shell escaping issues over SSH
        let tmuxChain =
            `${base64DecodeCmd(text)} | ${shellJoin([tmux, "load-buffer", "-"])} && ` +
            shellJoin([tmux, "paste-buffer", "-t", sessionName]);
        if (autoSubmit) {
            tmuxChain += ` && sleep 0.1 && ${shellJoin([tmux, "send-keys", "-t", sessionName, "Enter"])}`;
        }
        cmd = sshCommand(remote.remoteHost, ["sh", "-c", tmuxChain]);
    } else {
        cmd =
            shellJoin([tmux, "set-buffer", "--", text]) + " && " + shellJoin([tmux, "paste-buffer", "-t", sessionName]);
        if (autoSubmit) {
            cmd += ` && sleep 0.1 && ${shellJoin([tmux, "send-keys", "-t", sessionName, "Enter"])}`;
        }
    }

    const result = await getApi().execCommand(cmd);
    if (result.code !== 0) {
        return { ok: false, error: result.stderr || "Failed to send" };
    }
    return { ok: true };
}

async function sendToMultipleAgents(agents: string[], text: string, autoSubmit: boolean): Promise<SendResult> {
    const results = await Promise.all(
        agents.map(async (agent) => {
            const r = await sendToAgent(agent, text, autoSubmit);
            return { agent, ...r };
        })
    );
    const ok = results.filter((r) => r.ok).map((r) => r.agent);
    const failures = results.filter((r) => !r.ok).map((r) => r.agent);
    return { ok: failures.length === 0, agents: ok, failures };
}

// --- ViewModel ---

class HopperViewModel implements ViewModel {
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
        this.viewType = "hopper";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.viewIcon = jotai.atom("paper-plane");
        this.viewName = jotai.atom("Hopper");
        this.viewComponent = HopperView;
        this.endIconButtons = jotai.atom<IconButtonDecl[]>([]);
    }
}

// --- Shared Styles ---

const sectionHeaderStyle: React.CSSProperties = {
    cursor: "pointer",
    userSelect: "none",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    background: "rgba(255,255,255,0.02)",
};

const badgeStyle: React.CSSProperties = {
    fontSize: 9,
    padding: "1px 6px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.1)",
    color: "var(--secondary-text-color)",
};

const smallBtnStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--secondary-text-color)",
    fontSize: 10,
    padding: "2px 8px",
};

// --- Components ---

const AgentChip = React.memo(
    ({ session, selected, onToggle }: { session: SessionInfo; selected: boolean; onToggle: () => void }) => {
        const agentClr = agentColor(session.name);
        return (
            <button
                onClick={onToggle}
                className="text-[10px] font-semibold uppercase"
                style={{
                    padding: "3px 10px",
                    borderRadius: 10,
                    background: selected ? `${SELECTED_COLOR}25` : "rgba(255,255,255,0.04)",
                    color: selected ? SELECTED_COLOR : "var(--secondary-text-color)",
                    border: selected ? `1px solid ${SELECTED_COLOR}50` : "1px solid rgba(255,255,255,0.08)",
                    cursor: "pointer",
                    opacity: session.hasClaudeCode ? 1 : 0.4,
                    transition: "all 0.15s",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                }}
                title={session.hasClaudeCode ? `${session.name} — Claude Code active` : `${session.name} — shell only`}
            >
                <span
                    style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: selected
                            ? SELECTED_COLOR
                            : session.hasClaudeCode
                              ? agentClr
                              : "var(--secondary-text-color)",
                        display: "inline-block",
                    }}
                />
                {session.name}
            </button>
        );
    }
);
AgentChip.displayName = "AgentChip";

// --- Collapsible Section ---

const CollapsibleSection = React.memo(
    ({
        title,
        count,
        open,
        onToggle,
        accentColor,
        children,
    }: {
        title: string;
        count: number;
        open: boolean;
        onToggle: () => void;
        accentColor?: string;
        children: React.ReactNode;
    }) => (
        <div style={{ width: "100%" }}>
            <div style={sectionHeaderStyle} onClick={onToggle}>
                <i
                    className={`fa-sharp fa-solid fa-chevron-${open ? "down" : "right"}`}
                    style={{ fontSize: 8, color: "var(--secondary-text-color)", width: 10 }}
                />
                <span
                    className="text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: accentColor || "var(--secondary-text-color)" }}
                >
                    {title}
                </span>
                {count > 0 && <span style={badgeStyle}>{count}</span>}
            </div>
            {open && (
                <div className="flex flex-col gap-1 px-2 py-1.5" style={{ width: "100%" }}>
                    {children}
                </div>
            )}
        </div>
    )
);
CollapsibleSection.displayName = "CollapsibleSection";

// --- Inbox Entry ---

const InboxEntry = React.memo(
    ({ message, onLoad, onDismiss }: { message: InboxMessage; onLoad: () => void; onDismiss: () => void }) => {
        const fromColor = agentColor(message.from);
        const msgText = message.msg || "";
        const preview = msgText.length > 80 ? msgText.slice(0, 80) + "..." : msgText;
        return (
            <div
                className="flex items-start gap-2 px-2 py-1.5 rounded"
                style={{ background: "rgba(255,255,255,0.03)", width: "100%" }}
            >
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                            className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded"
                            style={{
                                background: `${fromColor}20`,
                                color: fromColor,
                                border: `1px solid ${fromColor}40`,
                            }}
                        >
                            {message.from}
                        </span>
                        {message.to && (
                            <>
                                <i
                                    className="fa-sharp fa-solid fa-arrow-right"
                                    style={{ fontSize: 7, color: "var(--secondary-text-color)" }}
                                />
                                <span
                                    className="text-[9px] font-bold uppercase"
                                    style={{ color: agentColor(message.to) }}
                                >
                                    {message.to}
                                </span>
                            </>
                        )}
                    </div>
                    <span className="text-[11px]" style={{ color: "var(--main-text-color)", lineHeight: 1.3 }}>
                        {preview}
                    </span>
                </div>
                <div className="flex gap-1 flex-shrink-0 mt-0.5">
                    <button onClick={onLoad} style={smallBtnStyle} title="Load into textarea">
                        <i className="fa-sharp fa-solid fa-arrow-up-right" />
                    </button>
                    <button onClick={onDismiss} style={{ ...smallBtnStyle, color: "#f87171" }} title="Dismiss">
                        <i className="fa-sharp fa-solid fa-xmark" />
                    </button>
                </div>
            </div>
        );
    }
);
InboxEntry.displayName = "InboxEntry";

// --- Draft Entry ---

const DraftEntry = React.memo(
    ({ draft, onLoad, onDelete }: { draft: Draft; onLoad: () => void; onDelete: () => void }) => {
        const firstLine = draft.text.split("\n")[0];
        const preview = firstLine.length > 70 ? firstLine.slice(0, 70) + "..." : firstLine;
        return (
            <div
                className="flex items-center gap-2 px-2 py-1.5 rounded"
                style={{ background: "rgba(255,255,255,0.03)", width: "100%" }}
            >
                <div className="flex-1 min-w-0">
                    {draft.label && (
                        <span className="text-[10px] font-semibold" style={{ color: "#60a5fa", marginRight: 6 }}>
                            {draft.label}
                        </span>
                    )}
                    <span
                        className="text-[11px] text-muted truncate"
                        style={{ display: "inline-block", maxWidth: "100%" }}
                    >
                        {preview}
                    </span>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                    <button onClick={onLoad} style={smallBtnStyle} title="Load into editor">
                        <i className="fa-sharp fa-solid fa-arrow-up-right" />
                    </button>
                    <button onClick={onDelete} style={{ ...smallBtnStyle, color: "#f87171" }} title="Delete draft">
                        <i className="fa-sharp fa-solid fa-trash" />
                    </button>
                </div>
            </div>
        );
    }
);
DraftEntry.displayName = "DraftEntry";

// --- Macro Entry ---

const MacroEntry = React.memo(
    ({
        macro,
        onSend,
        onEdit,
        onDelete,
        canSend,
    }: {
        macro: Macro;
        onSend: () => void;
        onEdit: () => void;
        onDelete: () => void;
        canSend: boolean;
    }) => {
        const preview = macro.text.length > 50 ? macro.text.slice(0, 50) + "..." : macro.text;
        return (
            <div
                className="flex items-center gap-2 px-2 py-1.5 rounded"
                style={{ background: "rgba(255,255,255,0.03)", width: "100%" }}
            >
                <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold" style={{ color: "#f59e0b" }}>
                        {macro.name}
                    </div>
                    <div className="text-[10px] text-muted truncate">{preview}</div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                    <button
                        onClick={onSend}
                        style={{
                            ...smallBtnStyle,
                            opacity: canSend ? 1 : 0.4,
                            color: canSend ? "#4ade80" : "var(--secondary-text-color)",
                        }}
                        disabled={!canSend}
                        title="Send to selected agents"
                    >
                        <i className="fa-sharp fa-solid fa-paper-plane" />
                    </button>
                    <button onClick={onEdit} style={smallBtnStyle} title="Edit macro">
                        <i className="fa-sharp fa-solid fa-pen" />
                    </button>
                    <button onClick={onDelete} style={{ ...smallBtnStyle, color: "#f87171" }} title="Delete macro">
                        <i className="fa-sharp fa-solid fa-trash" />
                    </button>
                </div>
            </div>
        );
    }
);
MacroEntry.displayName = "MacroEntry";

// --- Macro Editor Inline ---

const MacroEditor = React.memo(
    ({
        initial,
        onSave,
        onCancel,
    }: {
        initial: { name: string; text: string } | null;
        onSave: (name: string, text: string) => void;
        onCancel: () => void;
    }) => {
        const [name, setName] = React.useState(initial?.name || "");
        const [text, setText] = React.useState(initial?.text || "");

        return (
            <div
                className="flex flex-col gap-1.5 px-2 py-2 rounded"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Macro name..."
                    style={{
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 4,
                        padding: "4px 8px",
                        color: "var(--main-text-color)",
                        fontSize: 11,
                        outline: "none",
                    }}
                />
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Macro text..."
                    rows={3}
                    style={{
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 4,
                        padding: "6px 8px",
                        color: "var(--main-text-color)",
                        fontFamily: "var(--termfontfamily, monospace)",
                        fontSize: 11,
                        resize: "none",
                        outline: "none",
                    }}
                />
                <div className="flex gap-1 justify-end">
                    <button onClick={onCancel} style={smallBtnStyle}>
                        Cancel
                    </button>
                    <button
                        onClick={() => name.trim() && text.trim() && onSave(name.trim(), text.trim())}
                        style={{
                            ...smallBtnStyle,
                            color: name.trim() && text.trim() ? "#4ade80" : "var(--secondary-text-color)",
                            opacity: name.trim() && text.trim() ? 1 : 0.4,
                        }}
                    >
                        Save
                    </button>
                </div>
            </div>
        );
    }
);
MacroEditor.displayName = "MacroEditor";

// --- Queued Prompt Entry ---

const QueueEntry = React.memo(
    ({ queued, onDelete, onFireNow }: { queued: QueuedPrompt; onDelete: () => void; onFireNow: () => void }) => {
        const color = agentColor(queued.targetAgent);
        const preview = queued.text.length > 60 ? queued.text.slice(0, 60) + "..." : queued.text;
        const isWaiting = queued.status === "waiting";
        return (
            <div
                className="flex items-start gap-2 px-2 py-1.5 rounded"
                style={{
                    background: "rgba(255,255,255,0.03)",
                    width: "100%",
                    borderLeft: `3px solid ${isWaiting ? QUEUE_COLOR : "#22c55e"}`,
                }}
            >
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                            className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded"
                            style={{
                                background: `${color}20`,
                                color: color,
                                border: `1px solid ${color}40`,
                            }}
                        >
                            {queued.targetAgent}
                        </span>
                        <span className="text-[9px]" style={{ color: isWaiting ? QUEUE_COLOR : "#22c55e" }}>
                            {isWaiting ? "awaiting relay" : "sent"}
                        </span>
                        {queued.expectsPayload && (
                            <span
                                className="text-[8px] font-bold uppercase px-1 py-0.5 rounded"
                                style={{
                                    background: "rgba(251,191,36,0.15)",
                                    color: "#fbbf24",
                                    border: "1px solid rgba(251,191,36,0.3)",
                                }}
                                title="This prompt expects a payload from the previous agent"
                            >
                                payload
                            </span>
                        )}
                    </div>
                    <span className="text-[11px]" style={{ color: "var(--main-text-color)", lineHeight: 1.3 }}>
                        {preview}
                    </span>
                </div>
                <div className="flex gap-1 flex-shrink-0 mt-0.5">
                    {isWaiting && (
                        <button
                            onClick={onFireNow}
                            style={{ ...smallBtnStyle, color: "#4ade80" }}
                            title="Fire now (skip waiting for relay)"
                        >
                            <i className="fa-sharp fa-solid fa-bolt" />
                        </button>
                    )}
                    <button onClick={onDelete} style={{ ...smallBtnStyle, color: "#f87171" }} title="Remove from queue">
                        <i className="fa-sharp fa-solid fa-xmark" />
                    </button>
                </div>
            </div>
        );
    }
);
QueueEntry.displayName = "QueueEntry";

// --- Main View ---

const HopperView: React.FC<ViewComponentProps<HopperViewModel>> = ({ model }) => {
    // Core state
    const [text, setText] = React.useState("");
    const [sessions, setSessions] = React.useState<SessionInfo[]>([]);
    const [selectedAgents, setSelectedAgents] = React.useState<Set<string>>(new Set());
    const [sending, setSending] = React.useState(false);
    const [lastResult, setLastResult] = React.useState<SendResult | null>(null);
    const [autoSubmit, setAutoSubmit] = React.useState(false);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    // Drafts state
    const [drafts, setDrafts] = React.useState<Draft[]>([]);
    const [draftsOpen, setDraftsOpen] = React.useState(false);

    // Macros state
    const [macros, setMacros] = React.useState<Macro[]>([]);
    const [macrosOpen, setMacrosOpen] = React.useState(false);
    const [editingMacro, setEditingMacro] = React.useState<Macro | null>(null);
    const [creatingMacro, setCreatingMacro] = React.useState(false);

    // Inbox state
    const [inbox, setInbox] = React.useState<InboxMessage[]>([]);
    const [inboxOpen, setInboxOpen] = React.useState(false);

    // Queue state (relay chain)
    const [queue, setQueue] = React.useState<QueuedPrompt[]>([]);
    const [queueOpen, setQueueOpen] = React.useState(true);
    const [queuePayloadMode, setQueuePayloadMode] = React.useState(false);

    // Ref for queue to use in interval callback without stale closure. Always updated
    // synchronously through commitQueue so back-to-back updates never read a stale queue.
    const queueRef = React.useRef<QueuedPrompt[]>([]);
    const commitQueue = React.useCallback(async (updated: QueuedPrompt[], persist = true) => {
        queueRef.current = updated;
        setQueue(updated);
        if (persist) {
            await writeJsonFile(QUEUE_FILE, updated);
        }
    }, []);

    // --- Load persisted data on mount ---

    React.useEffect(() => {
        readJsonFile<Draft[]>(DRAFTS_FILE).then((d) => d && setDrafts(d));
        readJsonFile<Macro[]>(MACROS_FILE).then((m) => m && setMacros(m));
        readJsonFile<QueuedPrompt[]>(QUEUE_FILE).then((q) => q && commitQueue(q, false));
        readKeptInbox().then(setInbox);
    }, []);

    // --- Sessions polling ---

    const refreshSessions = React.useCallback(async () => {
        const data = await fetchActiveSessions();
        setSessions(data);
    }, []);

    React.useEffect(() => {
        refreshSessions();
        const interval = setInterval(refreshSessions, 10000);
        return () => clearInterval(interval);
    }, [refreshSessions]);

    // --- Fire a queued prompt ---

    const fireQueuedPrompt = React.useCallback(
        async (qp: QueuedPrompt, payload?: string) => {
            // Inject payload into prompt if present
            let promptText = qp.text;
            if (payload && qp.expectsPayload) {
                if (promptText.includes("{{payload}}")) {
                    promptText = promptText.replace(/\{\{payload\}\}/g, payload);
                } else {
                    // Prepend payload if no placeholder marker
                    promptText = `${payload}\n\n---\n\n${promptText}`;
                }
            }

            // Check if there are more waiting prompts AFTER this one
            const waitingAfter = queueRef.current.filter((q) => q.status === "waiting" && q.id !== qp.id);
            // If more dominoes remain, append relay instruction so the chain continues
            const nextQp = waitingAfter.length > 0 ? waitingAfter[0] : null;
            if (nextQp) {
                promptText += buildRelayInstruction(qp.targetAgent, nextQp.expectsPayload ?? false);
            }
            const result = await sendToAgent(qp.targetAgent, promptText, true);
            if (result.ok) {
                // Mark as sent, and have the next prompt wait for this agent's relay signal
                const updated = queueRef.current.map((q) => {
                    if (q.id === qp.id) return { ...q, status: "sent" as const };
                    if (nextQp && q.id === nextQp.id) return { ...q, relayFrom: qp.targetAgent };
                    return q;
                });
                await commitQueue(updated);

                // Remove from queue after 3 seconds
                setTimeout(() => {
                    commitQueue(queueRef.current.filter((q) => q.id !== qp.id));
                }, 3000);

                setLastResult({ ok: true, agents: [qp.targetAgent], failures: [] });
            } else {
                setLastResult({ ok: false, agents: [], failures: [qp.targetAgent] });
            }
        },
        [commitQueue]
    );

    // --- Inbox polling + relay signal detection ---

    const pollingRef = React.useRef(false);
    React.useEffect(() => {
        const interval = setInterval(async () => {
            if (pollingRef.current) return; // previous poll still running (slow ssh)
            pollingRef.current = true;
            try {
                const msgs = await consumeInbox();

                // Regular messages move to the kept file; relay signals are acted on and dropped
                const signals = msgs.filter((m) => m.signal === "relay");
                const nonSignals = msgs.filter((m) => m.signal !== "relay");
                await appendKeptInbox(nonSignals);

                // Each signal fires the head of the waiting queue only if it comes from the agent
                // that head is waiting on
                for (const signal of signals) {
                    const head = queueRef.current.find((q) => q.status === "waiting");
                    const from = (signal.from ?? "").toLowerCase();
                    if (head && head.relayFrom && head.relayFrom.toLowerCase() === from) {
                        await fireQueuedPrompt(head, signal.payload);
                    } else {
                        console.warn(
                            "[hopper] ignoring relay signal from",
                            signal.from,
                            "- queue head waits on",
                            head?.relayFrom
                        );
                    }
                }

                if (nonSignals.length > 0) {
                    setInbox(await readKeptInbox());
                }
            } catch (e) {
                console.error("[hopper] inbox poll failed", e);
            } finally {
                pollingRef.current = false;
            }
        }, 5000); // Poll every 5s for faster relay response
        return () => clearInterval(interval);
    }, [fireQueuedPrompt]);

    // --- Agent selection ---

    const toggleAgent = React.useCallback((name: string) => {
        setSelectedAgents((prev) => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
            }
            return next;
        });
    }, []);

    // --- Send ---

    const handleSend = React.useCallback(async () => {
        if (selectedAgents.size === 0 || !text.trim()) return;

        setSending(true);
        setLastResult(null);

        // If there are queued prompts waiting, auto-append the relay instruction to the first
        // target only, so exactly one agent signals, and the queue head waits on that agent.
        // Skip it if the head is already waiting on another agent's relay (no competing signals).
        const targets = Array.from(selectedAgents);
        const head = queueRef.current.find((q) => q.status === "waiting");
        let result: SendResult;
        if (head && !head.relayFrom) {
            const [relayAgent, ...others] = targets;
            const relayText = text + buildRelayInstruction(relayAgent, head.expectsPayload ?? false);
            const [first, rest] = await Promise.all([
                sendToAgent(relayAgent, relayText, autoSubmit),
                sendToMultipleAgents(others, text, autoSubmit),
            ]);
            if (first.ok) {
                await commitQueue(
                    queueRef.current.map((q) => (q.id === head.id ? { ...q, relayFrom: relayAgent } : q))
                );
            }
            const failures = [...(first.ok ? [] : [relayAgent]), ...rest.failures];
            result = {
                ok: failures.length === 0,
                agents: [...(first.ok ? [relayAgent] : []), ...rest.agents],
                failures,
            };
        } else {
            result = await sendToMultipleAgents(targets, text, autoSubmit);
        }
        setLastResult(result);
        setSending(false);

        if (result.ok) {
            setText("");
            textareaRef.current?.focus();
        }
    }, [selectedAgents, text, autoSubmit, commitQueue]);

    const handleKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSend();
            }
        },
        [handleSend]
    );

    // --- Queue ---

    const addToQueue = React.useCallback(async () => {
        if (selectedAgents.size === 0 || !text.trim()) return;
        const agents = Array.from(selectedAgents);
        const newEntries: QueuedPrompt[] = agents.map((agent) => ({
            id: crypto.randomUUID(),
            targetAgent: agent,
            text: text.trim(),
            createdAt: new Date().toISOString(),
            status: "waiting" as const,
            expectsPayload: queuePayloadMode,
        }));
        await commitQueue([...queueRef.current, ...newEntries]);
        setText("");
        setQueueOpen(true);
        setQueuePayloadMode(false);
        textareaRef.current?.focus();
    }, [text, selectedAgents, commitQueue]);

    const removeFromQueue = React.useCallback(
        async (id: string) => {
            await commitQueue(queueRef.current.filter((q) => q.id !== id));
        },
        [commitQueue]
    );

    const fireNow = React.useCallback(
        async (qp: QueuedPrompt) => {
            await fireQueuedPrompt(qp);
        },
        [fireQueuedPrompt]
    );

    // --- Drafts ---

    const saveDraft = React.useCallback(async () => {
        if (!text.trim()) return;
        const draft: Draft = {
            id: crypto.randomUUID(),
            text: text.trim(),
            createdAt: new Date().toISOString(),
        };
        const updated = [draft, ...drafts];
        setDrafts(updated);
        await writeJsonFile(DRAFTS_FILE, updated);
        setText("");
        setDraftsOpen(true);
        textareaRef.current?.focus();
    }, [text, drafts]);

    const loadDraft = React.useCallback((draft: Draft) => {
        setText(draft.text);
        textareaRef.current?.focus();
    }, []);

    const deleteDraft = React.useCallback(
        async (id: string) => {
            const updated = drafts.filter((d) => d.id !== id);
            setDrafts(updated);
            await writeJsonFile(DRAFTS_FILE, updated);
        },
        [drafts]
    );

    // --- Macros ---

    const saveMacro = React.useCallback(
        async (name: string, macroText: string) => {
            if (editingMacro) {
                const updated = macros.map((m) => (m.id === editingMacro.id ? { ...m, name, text: macroText } : m));
                setMacros(updated);
                await writeJsonFile(MACROS_FILE, updated);
                setEditingMacro(null);
            } else {
                const macro: Macro = {
                    id: crypto.randomUUID(),
                    name,
                    text: macroText,
                };
                const updated = [...macros, macro];
                setMacros(updated);
                await writeJsonFile(MACROS_FILE, updated);
                setCreatingMacro(false);
            }
        },
        [macros, editingMacro]
    );

    const deleteMacro = React.useCallback(
        async (id: string) => {
            const updated = macros.filter((m) => m.id !== id);
            setMacros(updated);
            await writeJsonFile(MACROS_FILE, updated);
        },
        [macros]
    );

    const sendMacro = React.useCallback(
        async (macro: Macro) => {
            if (selectedAgents.size === 0) return;
            setSending(true);
            setLastResult(null);
            const result = await sendToMultipleAgents(Array.from(selectedAgents), macro.text, autoSubmit);
            setLastResult(result);
            setSending(false);
        },
        [selectedAgents, autoSubmit]
    );

    // --- Inbox ---

    const loadInboxMessage = React.useCallback((msg: InboxMessage) => {
        setText(msg.msg || "");
        if (msg.to) {
            setSelectedAgents((prev) => {
                const next = new Set(prev);
                next.add(msg.to.toLowerCase());
                return next;
            });
        }
        textareaRef.current?.focus();
    }, []);

    const dismissInboxMessage = React.useCallback(async (message: InboxMessage) => {
        // remove from the current file on disk, never by rewriting it from React state
        await removeKeptInboxMessage(message);
        setInbox(await readKeptInbox());
    }, []);

    // --- Derived ---

    const waitingCount = queue.filter((q) => q.status === "waiting").length;
    const canSend = selectedAgents.size > 0 && text.trim() && !sending;
    const canQueue = selectedAgents.size > 0 && text.trim();
    const selectedColor = selectedAgents.size > 0 ? SELECTED_COLOR : FALLBACK_COLOR;

    const sendButtonText = sending
        ? null
        : selectedAgents.size === 0
          ? "Select agent"
          : selectedAgents.size === 1
            ? `Send to ${Array.from(selectedAgents)[0]}`
            : `Send to ${selectedAgents.size} agents`;

    // --- Status text ---

    const statusText = React.useMemo(() => {
        if (!lastResult) return null;
        if (lastResult.ok) {
            return `Sent to ${lastResult.agents.join(", ")}`;
        }
        if (lastResult.agents.length > 0) {
            return `Sent to ${lastResult.agents.join(", ")} — failed: ${lastResult.failures.join(", ")}`;
        }
        return `Failed: ${lastResult.failures.join(", ")}`;
    }, [lastResult]);

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
                    <span className="text-[12px] font-semibold text-muted uppercase tracking-wider">Hopper</span>
                    {waitingCount > 0 && (
                        <span
                            className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                            style={{
                                background: `${QUEUE_COLOR}20`,
                                color: QUEUE_COLOR,
                                border: `1px solid ${QUEUE_COLOR}40`,
                            }}
                        >
                            {waitingCount} queued
                        </span>
                    )}
                </div>
                <button
                    onClick={refreshSessions}
                    className="text-[11px] text-muted hover:text-white px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.05)", cursor: "pointer", border: "none" }}
                    title="Refresh sessions"
                >
                    <i className="fa-sharp fa-solid fa-arrows-rotate" />
                </button>
            </div>

            {/* Agent selector — multi-select */}
            <div
                className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 flex-wrap"
                style={{ width: "100%" }}
            >
                {sessions.length === 0 ? (
                    <span className="text-[11px] text-muted">No tmux sessions found</span>
                ) : (
                    sessions.map((s) => (
                        <AgentChip
                            key={s.name}
                            session={s}
                            selected={selectedAgents.has(s.name)}
                            onToggle={() => toggleAgent(s.name)}
                        />
                    ))
                )}
            </div>

            {/* Scrollable middle section */}
            <div className="flex-1 overflow-y-auto flex flex-col" style={{ minHeight: 0 }}>
                {/* Queue (relay chain) */}
                {queue.length > 0 && (
                    <CollapsibleSection
                        title="Queue"
                        count={waitingCount}
                        open={queueOpen}
                        onToggle={() => setQueueOpen(!queueOpen)}
                        accentColor={QUEUE_COLOR}
                    >
                        {queue.map((qp) => (
                            <QueueEntry
                                key={qp.id}
                                queued={qp}
                                onDelete={() => removeFromQueue(qp.id)}
                                onFireNow={() => fireNow(qp)}
                            />
                        ))}
                    </CollapsibleSection>
                )}

                {/* Inbox */}
                <CollapsibleSection
                    title="Inbox"
                    count={inbox.length}
                    open={inboxOpen}
                    onToggle={() => setInboxOpen(!inboxOpen)}
                    accentColor="#60a5fa"
                >
                    {inbox.length === 0 ? (
                        <span className="text-[10px] text-muted px-1">No messages</span>
                    ) : (
                        inbox.map((msg, idx) => (
                            <InboxEntry
                                key={idx}
                                message={msg}
                                onLoad={() => loadInboxMessage(msg)}
                                onDismiss={() => dismissInboxMessage(msg)}
                            />
                        ))
                    )}
                </CollapsibleSection>

                {/* Drafts */}
                <CollapsibleSection
                    title="Drafts"
                    count={drafts.length}
                    open={draftsOpen}
                    onToggle={() => setDraftsOpen(!draftsOpen)}
                    accentColor="#a78bfa"
                >
                    {drafts.length === 0 ? (
                        <span className="text-[10px] text-muted px-1">No saved drafts</span>
                    ) : (
                        drafts.map((d) => (
                            <DraftEntry
                                key={d.id}
                                draft={d}
                                onLoad={() => loadDraft(d)}
                                onDelete={() => deleteDraft(d.id)}
                            />
                        ))
                    )}
                </CollapsibleSection>

                {/* Textarea */}
                <div className="px-3 py-2 flex flex-col gap-1.5" style={{ width: "100%" }}>
                    {waitingCount > 0 && (
                        <div
                            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px]"
                            style={{
                                background: `${QUEUE_COLOR}10`,
                                border: `1px solid ${QUEUE_COLOR}30`,
                                color: QUEUE_COLOR,
                            }}
                        >
                            <i className="fa-sharp fa-solid fa-link" style={{ fontSize: 9 }} />
                            Relay mode: Send will auto-append relay instruction so the agent signals the Hopper when
                            done
                        </div>
                    )}
                    <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={
                            waitingCount > 0
                                ? "Type the FIRST step prompt — relay instruction will be auto-appended..."
                                : "Type your prompt here..."
                        }
                        className="text-[12px]"
                        style={{
                            width: "100%",
                            minHeight: 100,
                            resize: "vertical",
                            background: "rgba(255,255,255,0.03)",
                            border: waitingCount > 0 ? `1px solid ${QUEUE_COLOR}40` : "1px solid rgba(255,255,255,0.1)",
                            borderRadius: 6,
                            padding: "10px 12px",
                            color: "var(--main-text-color)",
                            fontFamily: "var(--termfontfamily, monospace)",
                            fontSize: 12,
                            lineHeight: 1.5,
                            outline: "none",
                        }}
                    />
                    <div className="flex justify-end gap-1.5">
                        <button
                            onClick={saveDraft}
                            disabled={!text.trim()}
                            style={{
                                ...smallBtnStyle,
                                opacity: text.trim() ? 1 : 0.4,
                                color: text.trim() ? "#a78bfa" : "var(--secondary-text-color)",
                            }}
                        >
                            <i className="fa-sharp fa-solid fa-bookmark" style={{ marginRight: 4 }} />
                            Save Draft
                        </button>
                        <label
                            className="flex items-center gap-1 cursor-pointer"
                            title="When checked, the previous agent's relay will include a payload that gets injected into this prompt. Use {{payload}} as a placeholder, or the payload will be prepended."
                        >
                            <input
                                type="checkbox"
                                checked={queuePayloadMode}
                                onChange={(e) => setQueuePayloadMode(e.target.checked)}
                                style={{ accentColor: "#fbbf24", cursor: "pointer", width: 12, height: 12 }}
                            />
                            <span
                                className="text-[9px]"
                                style={{ color: queuePayloadMode ? "#fbbf24" : "var(--secondary-text-color)" }}
                            >
                                Payload
                            </span>
                        </label>
                        <button
                            onClick={addToQueue}
                            disabled={!canQueue}
                            style={{
                                ...smallBtnStyle,
                                opacity: canQueue ? 1 : 0.4,
                                color: canQueue ? QUEUE_COLOR : "var(--secondary-text-color)",
                            }}
                            title="Queue this prompt — it will fire when a relay signal arrives"
                        >
                            <i className="fa-sharp fa-solid fa-clock" style={{ marginRight: 4 }} />
                            Queue
                        </button>
                    </div>
                </div>

                {/* Macros */}
                <CollapsibleSection
                    title="Macros"
                    count={macros.length}
                    open={macrosOpen}
                    onToggle={() => setMacrosOpen(!macrosOpen)}
                    accentColor="#f59e0b"
                >
                    {macros.map((m) =>
                        editingMacro?.id === m.id ? (
                            <MacroEditor
                                key={m.id}
                                initial={{ name: m.name, text: m.text }}
                                onSave={saveMacro}
                                onCancel={() => setEditingMacro(null)}
                            />
                        ) : (
                            <MacroEntry
                                key={m.id}
                                macro={m}
                                onSend={() => sendMacro(m)}
                                onEdit={() => setEditingMacro(m)}
                                onDelete={() => deleteMacro(m.id)}
                                canSend={selectedAgents.size > 0 && !sending}
                            />
                        )
                    )}
                    {creatingMacro ? (
                        <MacroEditor initial={null} onSave={saveMacro} onCancel={() => setCreatingMacro(false)} />
                    ) : (
                        <button
                            onClick={() => setCreatingMacro(true)}
                            style={{ ...smallBtnStyle, color: "#f59e0b", marginTop: 2 }}
                        >
                            <i className="fa-sharp fa-solid fa-plus" style={{ marginRight: 4 }} />
                            New Macro
                        </button>
                    )}
                </CollapsibleSection>
            </div>

            {/* Footer: auto-submit + send button + status */}
            <div
                className="flex items-center justify-between px-3 py-2 border-t border-white/10"
                style={{ width: "100%" }}
            >
                <div className="flex items-center gap-3">
                    <label
                        className="flex items-center gap-1.5 cursor-pointer"
                        title="When enabled, sends Enter after pasting to auto-submit the prompt"
                    >
                        <input
                            type="checkbox"
                            checked={autoSubmit}
                            onChange={(e) => setAutoSubmit(e.target.checked)}
                            style={{ accentColor: "#f59e0b", cursor: "pointer" }}
                        />
                        <span className="text-[10px] text-muted">Auto-submit</span>
                    </label>
                    {statusText && (
                        <span className="text-[10px]" style={{ color: lastResult?.ok ? "#22c55e" : "#ef4444" }}>
                            {statusText}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="text-[11px] font-semibold px-4 py-1.5 rounded"
                    style={{
                        background: canSend ? `${selectedColor}30` : "rgba(255,255,255,0.05)",
                        color: canSend ? selectedColor : "var(--secondary-text-color)",
                        border: canSend ? `1px solid ${selectedColor}50` : "1px solid rgba(255,255,255,0.08)",
                        cursor: canSend ? "pointer" : "default",
                        opacity: canSend ? 1 : 0.4,
                        transition: "all 0.15s",
                    }}
                >
                    {sending ? (
                        <i className="fa-sharp fa-solid fa-spinner fa-spin" />
                    ) : (
                        <>
                            <i className="fa-sharp fa-solid fa-paper-plane" style={{ marginRight: 6 }} />
                            {sendButtonText}
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export { HopperViewModel };
