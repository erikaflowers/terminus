// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getAgentInfo, globalConfigAtom, loadAvatarDataUrl } from "@/app/store/agents";
import { recordTEvent } from "@/app/store/global";
import * as util from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";

interface AgentButtonProps {
    agentName: string;
    changeAgentModalAtom: jotai.PrimitiveAtom<boolean>;
}

export const AgentButton = React.memo(
    React.forwardRef<HTMLDivElement, AgentButtonProps>(
        ({ agentName, changeAgentModalAtom }: AgentButtonProps, ref) => {
            const [, setAgentModalOpen] = jotai.useAtom(changeAgentModalAtom);
            const agentsPath = jotai.useAtomValue(globalConfigAtom).agentsPath;
            const agentInfo = agentName ? getAgentInfo(agentName) : null;
            const color = agentInfo?.color ?? "var(--grey-text-color)";
            const displayName = agentInfo?.name ?? null;
            const titleText = agentInfo ? `Agent: ${agentInfo.name} (${agentInfo.role})` : "No agent assigned";
            const [avatarDataUrl, setAvatarDataUrl] = React.useState<string | null>(null);

            React.useEffect(() => {
                setAvatarDataUrl(null);
                if (agentInfo?.avatarPath) {
                    loadAvatarDataUrl(agentInfo.avatarPath).then((url) => {
                        if (url) setAvatarDataUrl(url);
                    });
                }
            }, [agentInfo?.avatarPath, agentsPath]);

            const clickHandler = function () {
                recordTEvent("action:other", { "action:type": "agentdropdown", "action:initiator": "mouse" });
                setAgentModalOpen(true);
            };

            return (
                <div
                    ref={ref}
                    className="group flex items-center flex-nowrap overflow-hidden min-w-0 font-normal text-primary rounded-sm hover:bg-highlightbg cursor-pointer gap-[6px] px-[4px]"
                    onClick={clickHandler}
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
