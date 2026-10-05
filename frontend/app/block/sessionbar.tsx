// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// UI for home sessions (see sessionrestore.ts): the picker (what's running where the sessions live)
// and the bar a pane shows while it remembers a session but isn't attached to it.

import { AgentColorTable, getAgentColor } from "@/app/store/agents";
import { WOS } from "@/app/store/global";
import { Popover, PopoverButton, PopoverContent } from "@/element/popover";
import * as jotai from "jotai";
import * as React from "react";
import {
    attachPane,
    forgetSession,
    getAttachedAtom,
    getAttachErrorAtom,
    getHomeHost,
    hostDisplayName,
    launchAgentAtHome,
    listSessions,
    RemoteSession,
} from "./sessionrestore";
import { LocalHost } from "./sessionrestore-util";

export const sessionButtonStyle = (primary: boolean): React.CSSProperties => ({
    background: primary ? "var(--accent-color)" : "rgba(255,255,255,0.08)",
    border: "none",
    borderRadius: 4,
    color: primary ? "white" : "var(--main-text-color)",
    padding: "2px 10px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
});

const isCrewAgent = (name: string) => Object.prototype.hasOwnProperty.call(AgentColorTable, name?.toLowerCase());

const AgentDot = ({ name, attached }: { name: string; attached?: boolean }) => (
    <span
        style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 4,
            flexShrink: 0,
            background: attached ? (getAgentColor(name) ?? "var(--accent-color)") : "transparent",
            border: `1.5px solid ${getAgentColor(name) ?? "var(--grey-text-color)"}`,
        }}
    />
);

type SessionPickerProps = {
    host: string;
    current?: string;
    onPick: (session: string) => void;
};

/** What's running on `host`, freshly listed each time it mounts (it lives inside popovers). */
export const SessionPicker = ({ host, current, onPick }: SessionPickerProps) => {
    const [sessions, setSessions] = React.useState<RemoteSession[] | null | undefined>(undefined);
    const refresh = React.useCallback(() => {
        setSessions(undefined);
        listSessions(host).then(setSessions);
    }, [host]);
    React.useEffect(refresh, [refresh]);

    return (
        <div
            style={{
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "var(--block-bg-color)",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.1)",
                width: 240,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--main-text-color)", fontSize: 12, fontWeight: 600, flexGrow: 1 }}>
                    Running on {hostDisplayName(host)}
                </span>
                <span
                    title="Refresh"
                    onClick={refresh}
                    style={{ cursor: "pointer", color: "var(--grey-text-color)", fontSize: 11 }}
                >
                    <i className="fa-sharp fa-solid fa-arrows-rotate" />
                </span>
            </div>
            {sessions === undefined && <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>Looking…</span>}
            {sessions === null && (
                <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>
                    Couldn't reach {hostDisplayName(host)} (needs key-based ssh).
                </span>
            )}
            {sessions?.length === 0 && (
                <span style={{ color: "var(--grey-text-color)", fontSize: 11 }}>No tmux sessions running.</span>
            )}
            {sessions?.map((s) => (
                <button
                    key={s.name}
                    onClick={() => onPick(s.name)}
                    title={s.attached > 0 ? `${s.attached} client(s) attached` : "nobody attached"}
                    style={{
                        ...sessionButtonStyle(false),
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "5px 8px",
                        textAlign: "left",
                        fontFamily: "monospace",
                        outline: s.name === current ? "1px solid var(--accent-color)" : "none",
                    }}
                >
                    <AgentDot name={s.name} attached={s.attached > 0} />
                    <span style={{ flexGrow: 1 }}>{s.name}</span>
                    {s.attached > 0 && <span style={{ color: "var(--grey-text-color)", fontSize: 10 }}>{s.attached}</span>}
                </button>
            ))}
        </div>
    );
};

/** "Pick ▾" button + picker popover; picking attaches `blockId`. */
export const PickSessionButton = ({
    blockId,
    host,
    current,
    label,
    onError,
}: {
    blockId: string;
    host: string;
    current?: string;
    label: React.ReactNode;
    onError?: (msg: string) => void;
}) => (
    <Popover placement="bottom-start">
        <PopoverButton style={{ padding: 0, border: "none", background: "none", minWidth: 0 }}>{label}</PopoverButton>
        <PopoverContent>
            <SessionPicker
                host={host}
                current={current}
                onPick={async (name) => {
                    const err = await attachPane(blockId, host, name);
                    if (err) onError?.(err);
                }}
            />
        </PopoverContent>
    </Popover>
);

/**
 * Top-of-pane bar: shown while the pane remembers a session and isn't attached to it (it doesn't
 * hide for ordinary commands, so the terminal isn't resized under them). Attach reconnects; Pick
 * chooses another; × forgets it. Nothing ever connects by itself.
 */
export const SessionBar = ({ blockId }: { blockId: string }) => {
    const [block] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const attached = jotai.useAtomValue(getAttachedAtom(blockId));
    const error = jotai.useAtomValue(getAttachErrorAtom(blockId));
    const [localError, setLocalError] = React.useState<string>(null);
    const host = block?.meta?.["session:host"] as string;
    const session = block?.meta?.["session:tmux"] as string;

    React.useEffect(() => setLocalError(null), [host, session, attached]);

    const home = getHomeHost();
    if (attached != null || block?.meta?.["session:off"] || block?.meta?.view !== "term") {
        return null;
    }
    if (!host || !session) {
        // A pane with nothing remembered offers the picker, if sessions live on another machine
        return home === LocalHost ? null : <FreshPaneBar blockId={blockId} home={home} />;
    }
    const message = localError ?? error;
    const canLaunch = !!message && isCrewAgent(session);
    const attach = async () => setLocalError(await attachPane(blockId, host, session));
    const launch = async () => {
        const err = await launchAgentAtHome(host, session);
        setLocalError(err);
        if (!err) await attach();
    };

    return (
        <div style={barStyle}>
            <AgentDot name={session} attached />
            <span
                style={{
                    flexGrow: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: message ? "var(--warning-color, #e5b567)" : undefined,
                }}
                title={`${session} on ${host}`}
            >
                {message ?? (
                    <>
                        <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{session}</span>
                        <span style={{ color: "var(--grey-text-color)" }}> @ {hostDisplayName(host)}</span>
                    </>
                )}
            </span>
            {canLaunch ? (
                <button style={sessionButtonStyle(true)} onClick={launch} title={`Start ${session} running clauded`}>
                    Launch {session}
                </button>
            ) : (
                <button style={sessionButtonStyle(true)} onClick={attach}>
                    Attach
                </button>
            )}
            <PickSessionButton
                blockId={blockId}
                host={home}
                current={session}
                onError={setLocalError}
                label={<span style={sessionButtonStyle(false)}>Pick ▾</span>}
            />
            <span
                title="Forget this session (the pane stays a local shell)"
                onClick={() => forgetSession(blockId)}
                style={{ cursor: "pointer", color: "var(--grey-text-color)", padding: "0 4px" }}
            >
                <i className="fa-sharp fa-solid fa-xmark" />
            </span>
        </div>
    );
};

const barStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--main-text-color)",
    background: "rgba(255,255,255,0.05)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    flexShrink: 0,
    zIndex: 2,
};

/** New pane, nothing remembered: one-line offer to pick a session where they live. */
const FreshPaneBar = ({ blockId, home }: { blockId: string; home: string }) => {
    const [error, setError] = React.useState<string>(null);
    return (
        <div style={barStyle}>
            <i className="fa-sharp fa-solid fa-server" style={{ color: "var(--grey-text-color)", fontSize: 11 }} />
            <span style={{ flexGrow: 1, color: error ? "var(--warning-color, #e5b567)" : "var(--grey-text-color)" }}>
                {error ?? "Local shell."}
            </span>
            <PickSessionButton
                blockId={blockId}
                host={home}
                onError={setError}
                label={<span style={sessionButtonStyle(false)}>Pick a session on {hostDisplayName(home)} ▾</span>}
            />
            <span
                title="Hide (the header's server button still picks)"
                onClick={() => forgetSession(blockId)}
                style={{ cursor: "pointer", color: "var(--grey-text-color)", padding: "0 4px" }}
            >
                <i className="fa-sharp fa-solid fa-xmark" />
            </span>
        </div>
    );
};
