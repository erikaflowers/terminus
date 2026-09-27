// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane-header button for Session Restore (see sessionrestore.ts). Shows when the pane has run ssh
// or already remembers a session; the popover picks the host + tmux session and saves it.

import { Popover, PopoverButton, PopoverContent } from "@/element/popover";
import { useAtomValue } from "jotai";
import * as React from "react";
import {
    forgetSession,
    getDetectedSshAtom,
    listRemoteSessions,
    reconnectSession,
    rememberSession,
} from "./sessionrestore";

const inputStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 4,
    color: "var(--main-text-color)",
    padding: "6px 8px",
    fontSize: 12,
    fontFamily: "monospace",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
};

const buttonStyle = (primary: boolean): React.CSSProperties => ({
    background: primary ? "var(--accent-color)" : "rgba(255,255,255,0.08)",
    border: "none",
    borderRadius: 4,
    color: primary ? "white" : "var(--main-text-color)",
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
});

type SessionPanelProps = {
    blockId: string;
    savedHost: string;
    savedSession: string;
    defaultHost: string;
    defaultSession: string;
};

// Mounted only while the popover is open, so the remote session list is fresh each time.
const SessionPanel = ({ blockId, savedHost, savedSession, defaultHost, defaultSession }: SessionPanelProps) => {
    const [host, setHost] = React.useState(savedHost || defaultHost || "");
    const [session, setSession] = React.useState(savedSession || defaultSession || "");
    const [sessions, setSessions] = React.useState<{ name: string; attached: number }[] | null | undefined>(undefined);
    const [status, setStatus] = React.useState<string>(null);
    const remembered = !!savedHost;

    React.useEffect(() => {
        if (!host) {
            setSessions(null);
            return;
        }
        let cancelled = false;
        setSessions(undefined);
        const t = setTimeout(() => {
            listRemoteSessions(host).then((list) => {
                if (!cancelled) setSessions(list);
            });
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [host]);

    const handleRemember = React.useCallback(async () => {
        const ok = await rememberSession(blockId, host.trim(), session.trim());
        setStatus(ok ? "Saved. This pane reconnects whenever it starts." : "Invalid host or session name.");
    }, [blockId, host, session]);

    return (
        <div
            style={{
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--block-bg-color)",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.1)",
                width: 280,
            }}
        >
            <div style={{ color: "var(--main-text-color)", fontSize: 12, fontWeight: 600 }}>Session Restore</div>
            <div style={{ color: "var(--grey-text-color)", fontSize: 11 }}>
                Reconnect this pane to ssh + tmux every time Terminus starts. Enter reconnects after a drop.
            </div>
            <input style={inputStyle} value={host} placeholder="user@host" onChange={(e) => setHost(e.target.value)} />
            <input
                style={inputStyle}
                value={session}
                placeholder="tmux session"
                onChange={(e) => setSession(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") handleRemember();
                }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 20 }}>
                {sessions === undefined && host && (
                    <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>Looking up tmux sessions…</span>
                )}
                {sessions === null && host && (
                    <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>
                        Couldn't list sessions (needs key-based ssh). Type the name.
                    </span>
                )}
                {sessions?.map((s) => (
                    <button
                        key={s.name}
                        onClick={() => setSession(s.name)}
                        title={s.attached > 0 ? `${s.attached} client(s) attached` : "detached"}
                        style={{
                            ...buttonStyle(false),
                            padding: "2px 8px",
                            fontFamily: "monospace",
                            outline: s.name === session ? "1px solid var(--accent-color)" : "none",
                        }}
                    >
                        {s.attached > 0 ? "● " : "○ "}
                        {s.name}
                    </button>
                ))}
                {sessions?.length === 0 && (
                    <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>
                        No tmux sessions there yet; one will be created.
                    </span>
                )}
            </div>
            {status && <div style={{ color: "var(--grey-text-color)", fontSize: 11 }}>{status}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                {remembered && (
                    <button
                        style={buttonStyle(false)}
                        onClick={() => forgetSession(blockId).then(() => setStatus("Forgotten."))}
                    >
                        Forget
                    </button>
                )}
                {remembered && (
                    <button style={buttonStyle(false)} onClick={() => reconnectSession(blockId)}>
                        Reconnect now
                    </button>
                )}
                <button style={buttonStyle(true)} onClick={handleRemember} disabled={!host || !session}>
                    Remember
                </button>
            </div>
        </div>
    );
};

type SessionButtonProps = {
    blockId: string;
    savedHost?: string;
    savedSession?: string;
};

export const SessionButton = React.memo(({ blockId, savedHost, savedSession }: SessionButtonProps) => {
    const detected = useAtomValue(getDetectedSshAtom(blockId));
    if (!savedHost && !detected) {
        return null;
    }
    const remembered = !!savedHost;
    const title = remembered
        ? `Restores on start: ssh ${savedHost} → tmux ${savedSession}`
        : `Remember this connection (${detected.host})`;
    return (
        <Popover placement="bottom-start">
            <PopoverButton
                className="session-restore-trigger"
                style={{ padding: 0, border: "none", background: "none", minWidth: 0 }}
            >
                <span
                    className="inline-flex items-center justify-center flex-shrink-0 cursor-pointer rounded hover:bg-highlightbg"
                    style={{
                        width: 24,
                        height: 24,
                        color: remembered ? "var(--accent-color)" : "var(--grey-text-color)",
                        fontSize: 12,
                    }}
                    title={title}
                >
                    <i className={`fa-sharp fa-solid ${remembered ? "fa-link" : "fa-link-simple"}`} />
                </span>
            </PopoverButton>
            <PopoverContent className="session-restore-popover">
                <SessionPanel
                    blockId={blockId}
                    savedHost={savedHost}
                    savedSession={savedSession}
                    defaultHost={detected?.host}
                    defaultSession={detected?.tmuxSession}
                />
            </PopoverContent>
        </Popover>
    );
});
SessionButton.displayName = "SessionButton";
