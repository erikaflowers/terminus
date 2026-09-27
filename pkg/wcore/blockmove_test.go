// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func initTestStore(t *testing.T) context.Context {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("init wstore: %v", err)
	}
	return context.Background()
}

func pendingActions(t *testing.T, ctx context.Context, tabId string) []waveobj.LayoutActionData {
	t.Helper()
	layoutId, err := GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		t.Fatal(err)
	}
	ls, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutId)
	if err != nil {
		t.Fatal(err)
	}
	if ls.PendingBackendActions == nil {
		return nil
	}
	return *ls.PendingBackendActions
}

func TestMoveBlockToTab(t *testing.T) {
	ctx := initTestStore(t)
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	// empty tabs, no layout/presets (the pieces CreateEmptyTab builds on)
	srcTabId, err := createTab(ctx, ws.OID, "src", true, false, false)
	if err != nil {
		t.Fatal(err)
	}
	dstTabId, err := createTab(ctx, ws.OID, "dst", false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := pendingActions(t, ctx, dstTabId); len(got) != 0 {
		t.Fatalf("empty tab should have no pending layout actions, got %v", got)
	}
	block := &waveobj.Block{
		OID:        uuid.NewString(),
		ParentORef: waveobj.MakeORef(waveobj.OType_Tab, srcTabId).String(),
		Meta:       waveobj.MetaMapType{"view": "term", "controller": "shell"},
	}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	src, _ := wstore.DBMustGet[*waveobj.Tab](ctx, srcTabId)
	src.BlockIds = []string{block.OID}
	if err := wstore.DBUpdate(ctx, src); err != nil {
		t.Fatal(err)
	}

	if err := MoveBlockToTab(ctx, srcTabId, dstTabId, block.OID); err != nil {
		t.Fatalf("move: %v", err)
	}

	src, _ = wstore.DBMustGet[*waveobj.Tab](ctx, srcTabId)
	dst, _ := wstore.DBMustGet[*waveobj.Tab](ctx, dstTabId)
	if len(src.BlockIds) != 0 {
		t.Errorf("source tab still lists blocks: %v", src.BlockIds)
	}
	if len(dst.BlockIds) != 1 || dst.BlockIds[0] != block.OID {
		t.Errorf("destination tab blocks = %v, want [%s]", dst.BlockIds, block.OID)
	}
	moved, err := wstore.DBGet[*waveobj.Block](ctx, block.OID)
	if err != nil || moved == nil {
		t.Fatalf("block must still exist after a move (same id, same process): %v", err)
	}
	if want := waveobj.MakeORef(waveobj.OType_Tab, dstTabId).String(); moved.ParentORef != want {
		t.Errorf("block parent = %s, want %s", moved.ParentORef, want)
	}
	if moved.Meta["controller"] != "shell" {
		t.Errorf("block meta changed: %v", moved.Meta)
	}
	srcActs := pendingActions(t, ctx, srcTabId)
	if len(srcActs) != 1 || srcActs[0].ActionType != LayoutActionDataType_Detach || srcActs[0].BlockId != block.OID {
		t.Errorf("source layout actions = %+v, want one detach", srcActs)
	}
	dstActs := pendingActions(t, ctx, dstTabId)
	if len(dstActs) != 1 || dstActs[0].ActionType != LayoutActionDataType_Insert || dstActs[0].BlockId != block.OID || !dstActs[0].Focused {
		t.Errorf("destination layout actions = %+v, want one focused insert", dstActs)
	}

	// errors: same tab, block not in source tab
	if err := MoveBlockToTab(ctx, dstTabId, dstTabId, block.OID); err == nil {
		t.Error("moving to the same tab should fail")
	}
	if err := MoveBlockToTab(ctx, srcTabId, dstTabId, block.OID); err == nil {
		t.Error("moving a block that isn't in the source tab should fail")
	}
}
