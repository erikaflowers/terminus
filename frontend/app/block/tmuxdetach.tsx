// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Popover, PopoverButton, PopoverContent } from "@/element/popover";
import { getRemoteConfig, getTmuxCmd } from "@/app/store/agents";
import { atoms, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as React from "react";

interface TmuxDetachButtonProps {
    blockId: string;
    cwd: string;
}

function sanitizeSessionName(name: string): string {
    return name.replace(/[.:\/\s]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function getDefaultSessionName(cwd: string): string {
    if (!cwd) return "session";
    const parts = cwd.split("/").filter(Boolean);
    return sanitizeSessionName(parts[parts.length - 1] || "session");
}

export const TmuxDetachButton = React.memo(({ blockId, cwd }: TmuxDetachButtonProps) => {
    const [sessionName, setSessionName] = React.useState(() => getDefaultSessionName(cwd));

    React.useEffect(() => {
        setSessionName(getDefaultSessionName(cwd));
    }, [cwd]);

    const handleDetach = React.useCallback(async () => {
        const name = sanitizeSessionName(sessionName);
        if (!name) return;

        const remote = getRemoteConfig();
        const tmux = getTmuxCmd();
        const cwdArg = cwd ? ` -c "${cwd}"` : "";

        let initScript: string;
        if (remote?.remoteHost) {
            initScript = `ssh ${remote.remoteHost} -t "${tmux} new-session -A -s ${name}${cwdArg}"\n`;
        } else {
            initScript = `${tmux} new-session -A -s ${name}${cwdArg}\n`;
        }

        const tabId = globalStore.get(atoms.staticTabId);

        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: { "cmd:initscript.zsh": initScript },
        });

        await RpcApi.ControllerResyncCommand(TabRpcClient, {
            tabid: tabId,
            blockid: blockId,
            forcerestart: true,
        });
    }, [blockId, sessionName, cwd]);

    const handleKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleDetach();
            }
        },
        [handleDetach]
    );

    return (
        <Popover placement="bottom-start">
            <PopoverButton
                className="tmux-detach-trigger"
                style={{ padding: 0, border: "none", background: "none", minWidth: 0 }}
            >
                <span
                    className="inline-flex items-center justify-center flex-shrink-0 cursor-pointer rounded hover:bg-highlightbg"
                    style={{ width: 24, height: 24, color: "var(--grey-text-color)", fontSize: 12 }}
                    title="Detach to tmux session"
                >
                    <i className="fa-sharp fa-solid fa-right-from-bracket" />
                </span>
            </PopoverButton>
            <PopoverContent className="tmux-detach-popover">
                <div
                    style={{
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        background: "var(--block-bg-color)",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.1)",
                        width: 240,
                    }}
                >
                    <div style={{ color: "var(--main-text-color)", fontSize: 12, fontWeight: 600 }}>
                        Detach to tmux
                    </div>
                    <input
                        type="text"
                        value={sessionName}
                        onChange={(e) => setSessionName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Session name"
                        autoFocus
                        style={{
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
                        }}
                    />
                    {cwd && (
                        <div
                            style={{
                                color: "var(--grey-text-color)",
                                fontSize: 10,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                            title={cwd}
                        >
                            {cwd}
                        </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                            onClick={handleDetach}
                            style={{
                                background: "var(--accent-color)",
                                border: "none",
                                borderRadius: 4,
                                color: "white",
                                padding: "4px 12px",
                                fontSize: 12,
                                cursor: "pointer",
                            }}
                        >
                            Detach
                        </button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
});
TmuxDetachButton.displayName = "TmuxDetachButton";
