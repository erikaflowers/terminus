// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentButton } from "@/app/block/agentbutton";
import {
    blockViewToIcon,
    blockViewToName,
    getViewIconElem,
    OptMagnifyButton,
    renderHeaderElements,
} from "@/app/block/blockutil";
import { ColorPickerPopover } from "@/app/block/colorpicker";
import { TmuxDetachButton } from "@/app/block/tmuxdetach";
import { setAgentPref } from "@/app/store/agents";
import { DurableSessionFlyover } from "@/app/block/durable-session-flyover";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, recordTEvent, refocusNode, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { IconButton } from "@/element/iconbutton";
import { getLayoutModelForStaticTab, LayoutTreeActionType, NodeModel } from "@/layout/index";
import type { LayoutTreeResizeNodeAction } from "@/layout/index";
import { findNode, findParent } from "@/layout/lib/layoutNode";
import { FlexDirection } from "@/layout/lib/types";
import * as util from "@/util/util";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";
import { BlockFrameProps } from "./blocktypes";

function handleHeaderContextMenu(
    e: React.MouseEvent<HTMLDivElement>,
    blockId: string,
    viewModel: ViewModel,
    nodeModel: NodeModel
) {
    e.preventDefault();
    e.stopPropagation();
    const magnified = globalStore.get(nodeModel.isMagnified);
    let menu: ContextMenuItem[] = [
        {
            label: magnified ? "Un-Magnify Block" : "Magnify Block",
            click: () => {
                nodeModel.toggleMagnify();
            },
        },
        { type: "separator" },
        {
            label: "Copy BlockId",
            click: () => {
                navigator.clipboard.writeText(blockId);
            },
        },
    ];
    const extraItems = viewModel?.getSettingsMenuItems?.();
    if (extraItems && extraItems.length > 0) menu.push({ type: "separator" }, ...extraItems);
    menu.push(
        { type: "separator" },
        {
            label: "Close Block",
            click: () => uxCloseBlock(blockId),
        }
    );
    ContextMenuModel.getInstance().showContextMenu(menu, e);
}

type HeaderTextElemsProps = {
    viewModel: ViewModel;
    blockData: Block;
    preview: boolean;
    error?: Error;
};

const HeaderTextElems = React.memo(({ viewModel, blockData, preview, error }: HeaderTextElemsProps) => {
    let headerTextUnion = util.useAtomValueSafe(viewModel?.viewText);
    headerTextUnion = blockData?.meta?.["frame:text"] ?? headerTextUnion;

    const headerTextElems: React.ReactElement[] = [];
    if (typeof headerTextUnion === "string") {
        if (!util.isBlank(headerTextUnion)) {
            headerTextElems.push(
                <div key="text" className="block-frame-text ellipsis">
                    &lrm;{headerTextUnion}
                </div>
            );
        }
    } else if (Array.isArray(headerTextUnion)) {
        headerTextElems.push(...renderHeaderElements(headerTextUnion, preview));
    }
    if (error != null) {
        const copyHeaderErr = () => {
            navigator.clipboard.writeText(error.message + "\n" + error.stack);
        };
        headerTextElems.push(
            <div className="iconbutton disabled" key="controller-status" onClick={copyHeaderErr}>
                <i
                    className="fa-sharp fa-solid fa-triangle-exclamation"
                    title={"Error Rendering View Header: " + error.message}
                />
            </div>
        );
    }

    return <div className="block-frame-textelems-wrapper">{headerTextElems}</div>;
});
HeaderTextElems.displayName = "HeaderTextElems";

type HeaderEndIconsProps = {
    viewModel: ViewModel;
    nodeModel: NodeModel;
    blockId: string;
};

const COLLAPSED_SIZE = 5; // percentage — just enough for the header bar
const COLLAPSED_THRESHOLD = 8; // if size is at or below this, consider it collapsed

function toggleCollapseBlock(blockId: string, nodeId: string) {
    const layoutModel = getLayoutModelForStaticTab();
    if (!layoutModel) return;
    const node = layoutModel.getNodeByBlockId(blockId);
    if (!node) return;
    const parent = findParent(layoutModel.treeState.rootNode, node.id);
    // Can't collapse if there are no siblings (single pane)
    if (!parent?.children || parent.children.length < 2) return;
    // Only collapse in vertical (Column) layouts — horizontal would shrink width
    if (parent.flexDirection !== FlexDirection.Column) return;

    // Use metadata as source of truth — survives manual drag-resize
    const blockOref = WOS.makeORef("block", blockId);
    const blockAtom = WOS.getWaveObjectAtom<Block>(blockOref);
    const blockData = globalStore.get(blockAtom);
    const isCollapsed = blockData?.meta?.["frame:collapsed"] ?? false;

    // Split siblings into collapsed (frozen) and expandable — use metadata not size
    const allSiblings = parent.children.filter((c) => c.id !== node.id);
    const collapsedSiblings = allSiblings.filter((s) => {
        const sibOref = WOS.makeORef("block", s.data?.blockId);
        const sibAtom = WOS.getWaveObjectAtom<Block>(sibOref);
        const sibData = globalStore.get(sibAtom);
        return sibData?.meta?.["frame:collapsed"] ?? false;
    });
    const expandableSiblings = allSiblings.filter((s) => !collapsedSiblings.includes(s));
    const collapsedTotal = collapsedSiblings.reduce((sum, s) => sum + s.size, 0);

    if (isCollapsed) {
        // EXPAND: restore previous size from metadata, or default to fair share
        const savedSize = blockData?.meta?.["frame:prevsize"];
        const restoreSize = (savedSize && savedSize > COLLAPSED_THRESHOLD && savedSize <= 95)
            ? savedSize
            : Math.floor(100 / parent.children.length);
        const resizeOps: { nodeId: string; size: number }[] = [{ nodeId: node.id, size: restoreSize }];
        // Collapsed siblings stay frozen at their current size
        for (const sib of collapsedSiblings) {
            resizeOps.push({ nodeId: sib.id, size: sib.size });
        }
        // Only take space from expandable siblings
        const expandableTotal = expandableSiblings.reduce((sum, s) => sum + s.size, 0);
        const newExpandableTotal = 100 - restoreSize - collapsedTotal;
        let allocated = restoreSize + collapsedTotal;
        for (let i = 0; i < expandableSiblings.length; i++) {
            const sib = expandableSiblings[i];
            if (i === expandableSiblings.length - 1) {
                resizeOps.push({ nodeId: sib.id, size: 100 - allocated });
            } else {
                const ratio = expandableTotal > 0 ? sib.size / expandableTotal : 1 / expandableSiblings.length;
                const newSize = ratio * newExpandableTotal;
                resizeOps.push({ nodeId: sib.id, size: newSize });
                allocated += newSize;
            }
        }
        layoutModel.treeReducer({
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: resizeOps,
        } as LayoutTreeResizeNodeAction);
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: blockOref,
            meta: { "frame:collapsed": false },
        });
    } else {
        // COLLAPSE: save current size, shrink to minimum
        const currentSize = node.size;
        const resizeOps: { nodeId: string; size: number }[] = [{ nodeId: node.id, size: COLLAPSED_SIZE }];
        const freedSpace = currentSize - COLLAPSED_SIZE;
        // Collapsed siblings stay frozen at their current size
        for (const sib of collapsedSiblings) {
            resizeOps.push({ nodeId: sib.id, size: sib.size });
        }
        // Only give freed space to expandable siblings
        const expandableTotal = expandableSiblings.reduce((sum, s) => sum + s.size, 0);
        let allocated = COLLAPSED_SIZE + collapsedTotal;
        for (let i = 0; i < expandableSiblings.length; i++) {
            const sib = expandableSiblings[i];
            if (i === expandableSiblings.length - 1) {
                resizeOps.push({ nodeId: sib.id, size: 100 - allocated });
            } else {
                const ratio = expandableTotal > 0 ? sib.size / expandableTotal : 1 / expandableSiblings.length;
                const newSize = sib.size + ratio * freedSpace;
                resizeOps.push({ nodeId: sib.id, size: newSize });
                allocated += newSize;
            }
        }
        layoutModel.treeReducer({
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: resizeOps,
        } as LayoutTreeResizeNodeAction);
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: blockOref,
            meta: { "frame:collapsed": true, "frame:prevsize": currentSize },
        });
    }
}

const HeaderEndIcons = React.memo(({ viewModel, nodeModel, blockId }: HeaderEndIconsProps) => {
    const endIconButtons = util.useAtomValueSafe(viewModel?.endIconButtons);
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const ephemeral = jotai.useAtomValue(nodeModel.isEphemeral);
    const numLeafs = jotai.useAtomValue(nodeModel.numLeafs);
    const magnifyDisabled = numLeafs <= 1;
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const isCollapsed = blockData?.meta?.["frame:collapsed"] ?? false;

    const endIconsElem: React.ReactElement[] = [];

    if (endIconButtons && endIconButtons.length > 0) {
        endIconsElem.push(...endIconButtons.map((button, idx) => <IconButton key={idx} decl={button} />));
    }
    const settingsDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "cog",
        title: "Settings",
        click: (e) => handleHeaderContextMenu(e, blockId, viewModel, nodeModel),
    };
    endIconsElem.push(<IconButton key="settings" decl={settingsDecl} className="block-frame-settings" />);
    if (ephemeral) {
        const addToLayoutDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "circle-plus",
            title: "Add to Layout",
            click: () => {
                nodeModel.addEphemeralNodeToLayout();
            },
        };
        endIconsElem.push(<IconButton key="add-to-layout" decl={addToLayoutDecl} />);
    } else {
        endIconsElem.push(
            <OptMagnifyButton
                key="unmagnify"
                magnified={magnified}
                toggleMagnify={() => {
                    nodeModel.toggleMagnify();
                    setTimeout(() => refocusNode(blockId), 50);
                }}
                disabled={magnifyDisabled}
            />
        );
    }

    // Collapse/expand toggle — only in vertical layouts with siblings
    const canCollapse = React.useMemo(() => {
        const layoutModel = getLayoutModelForStaticTab();
        if (!layoutModel) return false;
        const node = layoutModel.getNodeByBlockId(blockId);
        if (!node) return false;
        const parent = findParent(layoutModel.treeState.rootNode, node.id);
        if (!parent?.children || parent.children.length < 2) return false;
        if (parent.flexDirection !== FlexDirection.Column) return false;
        return true;
    }, [blockId, numLeafs]);

    if (canCollapse) {
        const collapseDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: isCollapsed ? "chevron-right" : "chevron-down",
            title: isCollapsed ? "Expand" : "Collapse",
            click: () => toggleCollapseBlock(blockId, nodeModel.nodeId),
        };
        endIconsElem.push(<IconButton key="collapse" decl={collapseDecl} />);
    }

    const closeDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: "Close",
        click: () => uxCloseBlock(nodeModel.blockId),
    };
    endIconsElem.push(<IconButton key="close" decl={closeDecl} className="block-frame-default-close" />);

    return <div className="block-frame-end-icons">{endIconsElem}</div>;
});
HeaderEndIcons.displayName = "HeaderEndIcons";

const BlockFrame_Header = ({
    nodeModel,
    viewModel,
    preview,
    agentBtnRef,
    changeAgentModalAtom,
    error,
}: BlockFrameProps & {
    changeAgentModalAtom?: jotai.PrimitiveAtom<boolean>;
    error?: Error;
}) => {
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", nodeModel.blockId));
    let viewName = util.useAtomValueSafe(viewModel?.viewName) ?? blockViewToName(blockData?.meta?.view);
    let viewIconUnion = util.useAtomValueSafe(viewModel?.viewIcon) ?? blockViewToIcon(blockData?.meta?.view);
    const preIconButton = util.useAtomValueSafe(viewModel?.preIconButton);
    const useTermHeader = util.useAtomValueSafe(viewModel?.useTermHeader);
    const termConfigedDurable = util.useAtomValueSafe(viewModel?.termConfigedDurable);
    const hideViewName = util.useAtomValueSafe(viewModel?.hideViewName);
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const prevMagifiedState = React.useRef(magnified);
    const manageAgent = util.useAtomValueSafe(viewModel?.manageAgent);
    const currentBgColor = util.useAtomValueSafe(viewModel?.currentBgColor);
    const dragHandleRef = preview ? null : nodeModel.dragHandleRef;
    const isTerminalBlock = blockData?.meta?.view === "term";
    viewName = blockData?.meta?.["frame:title"] ?? viewName;
    viewIconUnion = blockData?.meta?.["frame:icon"] ?? viewIconUnion;

    React.useEffect(() => {
        if (magnified && !preview && !prevMagifiedState.current) {
            RpcApi.ActivityCommand(TabRpcClient, { nummagnify: 1 });
            recordTEvent("action:magnify", { "block:view": viewName });
        }
        prevMagifiedState.current = magnified;
    }, [magnified]);

    const viewIconElem = getViewIconElem(viewIconUnion, blockData);
    const agentAccentColor = blockData?.meta?.["agent:color"] as string;

    const handleBgColorChange = React.useCallback(
        async (hex: string) => {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", nodeModel.blockId),
                meta: { "term:bgcolor": hex },
            });
            const agentName = blockData?.meta?.["agent:name"] as string;
            if (agentName) {
                await setAgentPref(agentName, "term:bgcolor", hex);
            }
        },
        [nodeModel.blockId, blockData]
    );

    const handleBgColorReset = React.useCallback(async () => {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", nodeModel.blockId),
            meta: { "term:bgcolor": null },
        });
        const agentName = blockData?.meta?.["agent:name"] as string;
        if (agentName) {
            await setAgentPref(agentName, "term:bgcolor", null);
        }
    }, [nodeModel.blockId, blockData]);

    return (
        <div
            className={cn("block-frame-default-header", useTermHeader && "!pl-[2px]")}
            data-role="block-header"
            ref={dragHandleRef}
            onContextMenu={(e) => handleHeaderContextMenu(e, nodeModel.blockId, viewModel, nodeModel)}
            style={agentAccentColor ? { borderTop: `2px solid ${agentAccentColor}` } : undefined}
        >
            {!useTermHeader && (
                <>
                    {preIconButton && <IconButton decl={preIconButton} className="block-frame-preicon-button" />}
                    <div className="block-frame-default-header-iconview">
                        {viewIconElem}
                        {viewName && !hideViewName && <div className="block-frame-view-type">{viewName}</div>}
                    </div>
                </>
            )}
            {manageAgent && changeAgentModalAtom && (
                <AgentButton
                    ref={agentBtnRef}
                    key="agentbutton"
                    agentName={blockData?.meta?.["agent:name"] as string}
                    changeAgentModalAtom={changeAgentModalAtom}
                />
            )}
            {isTerminalBlock && currentBgColor && (
                <ColorPickerPopover
                    currentColor={currentBgColor}
                    onColorChange={handleBgColorChange}
                    onReset={handleBgColorReset}
                />
            )}
            {isTerminalBlock && (
                <TmuxDetachButton
                    blockId={nodeModel.blockId}
                    cwd={(blockData?.meta?.["cmd:cwd"] as string) ?? ""}
                />
            )}
            {isTerminalBlock && (
                <span
                    className="inline-flex items-center justify-center flex-shrink-0 cursor-pointer rounded hover:bg-highlightbg"
                    style={{ width: 24, height: 24, color: "var(--grey-text-color)", fontSize: 12 }}
                    title="Restart shell"
                    onClick={async () => {
                        const tabId = globalStore.get(atoms.staticTabId);
                        await RpcApi.ControllerResyncCommand(TabRpcClient, {
                            tabid: tabId,
                            blockid: nodeModel.blockId,
                            forcerestart: true,
                        });
                    }}
                >
                    <i className="fa-sharp fa-solid fa-arrow-rotate-right" />
                </span>
            )}
            {useTermHeader && termConfigedDurable != null && (
                <DurableSessionFlyover
                    key="durable-status"
                    blockId={nodeModel.blockId}
                    viewModel={viewModel}
                    placement="bottom"
                    divClassName="iconbutton disabled text-[13px] ml-[-4px]"
                />
            )}
            <HeaderTextElems viewModel={viewModel} blockData={blockData} preview={preview} error={error} />
            <HeaderEndIcons viewModel={viewModel} nodeModel={nodeModel} blockId={nodeModel.blockId} />
        </div>
    );
};

export { BlockFrame_Header };
