// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// "Open workspace from <machine>?": shown when a Clone Workspace snapshot arrives (or is pasted).

import { Modal } from "@/app/modals/modal";
import { getApi } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import * as React from "react";
import { openWorkspaceSnapshot } from "./workspaceclone";
import { hostLabel, WorkspaceSnapshot } from "./workspaceclone-util";

function paneLabel(meta: Record<string, any>): string {
    const session = meta?.["session:tmux"];
    const host = meta?.["session:host"];
    if (session && host) {
        return `${session} @ ${hostLabel(host)}`;
    }
    return meta?.["agent:name"] || meta?.["frame:title"] || meta?.view || "pane";
}

const WorkspaceSnapshotModal = ({ snapshot, file }: { snapshot: WorkspaceSnapshot; file?: string }) => {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>(null);
    const done = React.useRef(false);

    const finish = (accepted: boolean) => {
        if (!done.current && file) {
            done.current = true;
            getApi().workspaceSnapshotDone(file, accepted);
        }
        modalsModel.popModal();
    };

    const handleOpen = async () => {
        setBusy(true);
        try {
            await openWorkspaceSnapshot(snapshot);
            finish(true);
        } catch (e) {
            setError(String(e?.message ?? e));
            setBusy(false);
        }
    };

    const tabs = snapshot?.tabs ?? [];
    return (
        <Modal
            okLabel="Open in New Window"
            cancelLabel="Discard"
            onOk={handleOpen}
            onCancel={() => finish(false)}
            onClose={() => finish(false)}
            okDisabled={busy}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 320 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                    Open workspace from {snapshot?.from || "another machine"}?
                </div>
                {tabs.map((t, i) => (
                    <div key={i} style={{ fontSize: 12 }}>
                        <div style={{ fontWeight: 600 }}>{t.name || `Tab ${i + 1}`}</div>
                        <div style={{ color: "var(--grey-text-color)", fontFamily: "monospace" }}>
                            {t.blocks.map((b) => paneLabel(b.meta)).join(" · ")}
                        </div>
                    </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--grey-text-color)" }}>
                    Remembered sessions reconnect on their own; sessions hosted on this machine attach locally.
                </div>
                {error && <div style={{ fontSize: 12, color: "var(--error-color)" }}>{error}</div>}
            </div>
        </Modal>
    );
};

WorkspaceSnapshotModal.displayName = "WorkspaceSnapshotModal";

export { WorkspaceSnapshotModal };
