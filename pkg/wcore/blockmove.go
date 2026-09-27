// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MoveBlockToTab moves a block (a pane) from one tab to another. The block keeps its id, so its
// controller and process (shell, ssh, tmux…) keep running untouched: this is a real move, not a
// reconnect. The source tab detaches the node from its layout (without deleting the block) and
// the destination tab inserts it focused.
func MoveBlockToTab(ctx context.Context, srcTabId string, dstTabId string, blockId string) error {
	if srcTabId == dstTabId {
		return fmt.Errorf("block is already in tab %s", dstTabId)
	}
	err := wstore.MoveBlockToTab(ctx, srcTabId, dstTabId, blockId)
	if err != nil {
		return err
	}
	err = QueueLayoutActionForTab(ctx, srcTabId, waveobj.LayoutActionData{
		ActionType: LayoutActionDataType_Detach,
		BlockId:    blockId,
	})
	if err != nil {
		return fmt.Errorf("error detaching block from source layout: %w", err)
	}
	err = QueueLayoutActionForTab(ctx, dstTabId, waveobj.LayoutActionData{
		ActionType: LayoutActionDataType_Insert,
		BlockId:    blockId,
		Focused:    true,
	})
	if err != nil {
		return fmt.Errorf("error inserting block into destination layout: %w", err)
	}
	return nil
}
