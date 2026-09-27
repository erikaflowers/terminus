// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A workspace snapshot, as sent from another machine (Clone Workspace). Each tab carries its
// layout tree (rootnode) with leaves pointing at an index into Blocks instead of a block id;
// importing creates fresh blocks and writes the same tree, so splits, directions and sizes match.
type WorkspaceSnapshot struct {
	Type    string                 `json:"type"`
	Version int                    `json:"version"`
	From    string                 `json:"from,omitempty"`
	Tabs    []WorkspaceSnapshotTab `json:"tabs"`
}

type WorkspaceSnapshotTab struct {
	Name              string              `json:"name"`
	RootNode          map[string]any      `json:"rootnode"`
	Blocks            []*waveobj.BlockDef `json:"blocks"`
	FocusedBlockIndex int                 `json:"focusedblockindex"`
}

const (
	WorkspaceSnapshotType = "terminus-workspace"
	maxSnapshotTabs       = 32
	maxSnapshotBlocks     = 64
	maxSnapshotDepth      = 16
)

func ParseWorkspaceSnapshot(data []byte) (*WorkspaceSnapshot, error) {
	var snap WorkspaceSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("invalid workspace snapshot: %w", err)
	}
	if snap.Type != WorkspaceSnapshotType || snap.Version != 1 {
		return nil, fmt.Errorf("not a terminus workspace snapshot (type %q, version %d)", snap.Type, snap.Version)
	}
	if len(snap.Tabs) == 0 || len(snap.Tabs) > maxSnapshotTabs {
		return nil, fmt.Errorf("workspace snapshot has %d tabs", len(snap.Tabs))
	}
	for _, t := range snap.Tabs {
		if len(t.Blocks) == 0 || len(t.Blocks) > maxSnapshotBlocks || t.RootNode == nil {
			return nil, fmt.Errorf("workspace snapshot tab %q is empty or too large", t.Name)
		}
	}
	return &snap, nil
}

// rebuildLayoutNode copies a snapshot layout node with fresh node ids, mapping leaf
// data.blockindex to the new block ids. Returns nil for leaves with no valid block.
func rebuildLayoutNode(node map[string]any, blockIds []string, depth int, focusIdx int, focusedNodeId *string) map[string]any {
	if node == nil || depth > maxSnapshotDepth {
		return nil
	}
	out := map[string]any{"id": uuid.NewString()}
	if fd, ok := node["flexDirection"].(string); ok && (fd == "row" || fd == "column") {
		out["flexDirection"] = fd
	}
	if size, ok := node["size"].(float64); ok && size > 0 {
		out["size"] = size
	}
	if data, ok := node["data"].(map[string]any); ok {
		idx, ok := data["blockindex"].(float64)
		if !ok || int(idx) < 0 || int(idx) >= len(blockIds) || float64(int(idx)) != idx {
			return nil
		}
		out["data"] = map[string]any{"blockId": blockIds[int(idx)]}
		if int(idx) == focusIdx {
			*focusedNodeId = out["id"].(string)
		}
		return out
	}
	rawChildren, _ := node["children"].([]any)
	children := make([]any, 0, len(rawChildren))
	for _, rc := range rawChildren {
		if cm, ok := rc.(map[string]any); ok {
			if child := rebuildLayoutNode(cm, blockIds, depth+1, focusIdx, focusedNodeId); child != nil {
				children = append(children, child)
			}
		}
	}
	if len(children) == 0 {
		return nil
	}
	out["children"] = children
	return out
}

// ImportSnapshotTab fills an existing empty tab from a snapshot tab: creates its blocks (their
// processes start when the tab renders) and writes the rebuilt layout tree.
func ImportSnapshotTab(ctx context.Context, tabId string, st WorkspaceSnapshotTab) error {
	if st.Name != "" {
		if err := wstore.UpdateTabName(ctx, tabId, st.Name); err != nil {
			return fmt.Errorf("error naming tab: %w", err)
		}
	}
	blockIds := make([]string, len(st.Blocks))
	for i, def := range st.Blocks {
		if def == nil {
			def = &waveobj.BlockDef{}
		}
		block, err := CreateBlock(ctx, tabId, def, &waveobj.RuntimeOpts{})
		if err != nil {
			return fmt.Errorf("error creating block: %w", err)
		}
		blockIds[i] = block.OID
	}
	var focusedNodeId string
	root := rebuildLayoutNode(st.RootNode, blockIds, 0, st.FocusedBlockIndex, &focusedNodeId)
	if root == nil {
		return fmt.Errorf("workspace snapshot tab %q has no usable layout", st.Name)
	}
	layoutId, err := GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		return err
	}
	ls, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutId)
	if err != nil {
		return fmt.Errorf("error getting layout state: %w", err)
	}
	ls.RootNode = root
	ls.FocusedNodeId = focusedNodeId
	ls.PendingBackendActions = nil
	return wstore.DBUpdate(ctx, ls)
}
