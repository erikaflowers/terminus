// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane-header button for home sessions (see sessionrestore.ts): opens the picker of what's running
// where the sessions live; picking attaches this pane. Accent-colored while the pane remembers one.

import { useAtomValue } from "jotai";
import * as React from "react";
import { PickSessionButton } from "./sessionbar";
import { getAttachedAtom, getHomeHost, hostDisplayName } from "./sessionrestore";

type SessionButtonProps = {
    blockId: string;
    savedHost?: string;
    savedSession?: string;
};

export const SessionButton = React.memo(({ blockId, savedHost, savedSession }: SessionButtonProps) => {
    const attached = useAtomValue(getAttachedAtom(blockId));
    const home = getHomeHost();
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
