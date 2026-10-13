// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useHomeHost } from "@/app/block/sessionrestore";
import { getAgentInfo, globalConfigAtom, loadAgentAvatar, syncedLookMeta } from "@/app/store/agents";
import { WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as util from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";

interface AgentButtonProps {
    blockId: string;
    agentName: string;
}

const LookSyncMs = 60_000;

// The pane's agent badge. Display only: the agent follows the attached tmux session
// (sessionrestore.ts rememberSession), so the session picker is the one place to choose.

export const AgentButton = React.memo(
    React.forwardRef<HTMLDivElement, AgentButtonProps>(
        ({ blockId, agentName }: AgentButtonProps, ref) => {
            const homeHost = useHomeHost();
            const agentsPath = jotai.useAtomValue(globalConfigAtom).agentsPath;
            const agentInfo = agentName ? getAgentInfo(agentName) : null;
            const color = agentInfo?.color ?? "var(--grey-text-color)";
            const displayName = agentInfo?.name ?? null;
            const titleText = agentInfo ? `Agent: ${agentInfo.name} (${agentInfo.role})` : "No agent assigned";
            const [avatarDataUrl, setAvatarDataUrl] = React.useState<string | null>(null);

            React.useEffect(() => {
                setAvatarDataUrl(null);
                if (!agentInfo) return;
                let live = true;
                loadAgentAvatar(agentInfo.name).then((url) => {
                    if (live && url) setAvatarDataUrl(url);
                });
                return () => {
                    live = false;
                };
            }, [agentInfo?.name, agentsPath, homeHost]);

            // Wear the agent's look as saved on home, now and about once a minute
            React.useEffect(() => {
                if (!agentInfo) return;
                const sync = async () => {
                    const meta = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta;
                    const look = await syncedLookMeta(meta);
                    if (look) {
                        await RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("block", blockId), meta: look });
                    }
                };
                sync();
                const timer = setInterval(sync, LookSyncMs);
                return () => clearInterval(timer);
            }, [blockId, agentInfo?.name, homeHost]);

            return (
                <div
                    ref={ref}
                    className="group flex items-center flex-nowrap overflow-hidden min-w-0 font-normal text-primary rounded-sm gap-[6px] px-[4px]"
                    title={titleText}
                >
                    {avatarDataUrl ? (
                        <img
                            src={avatarDataUrl}
                            alt={displayName}
                            className="rounded-full object-cover flex-shrink-0"
                            style={{
                                width: 32,
                                height: 32,
                                border: `2px solid ${color}`,
                            }}
                        />
                    ) : (
                        <span
                            className="inline-block rounded-full flex-shrink-0"
                            style={{
                                width: displayName ? 32 : 10,
                                height: displayName ? 32 : 10,
                                backgroundColor: color,
                                opacity: displayName ? 0.3 : 1,
                            }}
                        />
                    )}
                    <div
                        className={util.cn(
                            "flex flex-col overflow-hidden pr-1 leading-tight",
                            !displayName && "text-muted"
                        )}
                    >
                        {displayName ? (
                            <>
                                <span className="text-[13px] font-semibold ellipsis" style={{ color }}>
                                    {displayName}
                                </span>
                                <span className="text-[10px] text-muted ellipsis">{agentInfo?.role}</span>
                            </>
                        ) : (
                            <span className="text-[12px] ellipsis">No Agent</span>
                        )}
                    </div>
                </div>
            );
        }
    )
);
AgentButton.displayName = "AgentButton";
