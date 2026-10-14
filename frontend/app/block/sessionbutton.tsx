// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane-header button for home sessions (see sessionrestore.ts): opens the picker of what's running
// where the sessions live; picking attaches this pane. Accent-colored while the pane remembers one.

import { useAtomValue } from "jotai";
import * as React from "react";
import { PickSessionButton } from "./sessionbar";
import { getAttachedAtom, hostDisplayName, reattachPane, useHomeHost } from "./sessionrestore";

type SessionButtonProps = {
    blockId: string;
    savedHost?: string;
    savedSession?: string;
};

export const SessionButton = React.memo(({ blockId, savedHost, savedSession }: SessionButtonProps) => {
    const attached = useAtomValue(getAttachedAtom(blockId));
    const home = useHomeHost();
    const title = attached
        ? `Attached: ${attached.session} @ ${hostDisplayName(attached.host)}`
        : savedSession
          ? `Remembers ${savedSession} @ ${hostDisplayName(savedHost)}. Click to pick a session on ${hostDisplayName(home)}`
          : `Pick a session on ${hostDisplayName(home)}`;
    return (
        <PickSessionButton
            blockId={blockId}
            host={home}
            current={attached?.session ?? savedSession}
            label={
                <span
                    className="inline-flex items-center justify-center flex-shrink-0 cursor-pointer rounded hover:bg-highlightbg"
                    style={{
                        width: 24,
                        height: 24,
                        color: attached || savedSession ? "var(--accent-color)" : "var(--grey-text-color)",
                        fontSize: 12,
                    }}
                    title={title}
                >
                    <i className="fa-sharp fa-solid fa-server" />
                </span>
            }
        />
    );
});
SessionButton.displayName = "SessionButton";

/**
 * Resume the session this pane remembers without opening the picker: for when the pipe breaks.
 * Restarts the pane's shell and reattaches (sessionrestore.ts reattachPane).
 */
export const ReattachButton = React.memo(({ blockId, savedHost, savedSession }: SessionButtonProps) => {
    const [busy, setBusy] = React.useState(false);
    const enabled = !!(savedHost && savedSession) && !busy;
    const title = savedSession
        ? `Reattach ${savedSession} @ ${hostDisplayName(savedHost)} (restarts this pane's shell)`
        : "No session to reattach. Pick one first";
    const onClick = async () => {
        if (!enabled) return;
        setBusy(true);
        try {
            await reattachPane(blockId);
        } finally {
            setBusy(false);
        }
    };
    return (
        <span
            className={
                "inline-flex items-center justify-center flex-shrink-0 rounded" +
                (enabled ? " cursor-pointer hover:bg-highlightbg" : "")
            }
            style={{
                width: 24,
                height: 24,
                color: "var(--grey-text-color)",
                opacity: savedSession ? 1 : 0.35,
                fontSize: 12,
            }}
            title={title}
            onClick={onClick}
        >
            <i className={"fa-sharp fa-solid fa-recycle" + (busy ? " fa-spin" : "")} />
        </span>
    );
});
ReattachButton.displayName = "ReattachButton";
