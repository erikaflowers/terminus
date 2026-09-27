// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Three panes like Samantha's: siddig on the left, lee over renner on the right (70/30).
const testSnapshot = `{
  "type": "terminus-workspace", "version": 1, "from": "air",
  "tabs": [{
    "name": "Crew",
    "focusedblockindex": 2,
    "blocks": [
      {"meta": {"view": "term", "controller": "shell", "session:host": "erikflowers@mac-studio-2", "session:tmux": "siddig"}},
      {"meta": {"view": "term", "controller": "shell", "session:host": "juliansiddig@julians-mac-mini", "session:tmux": "lee"}},
      {"meta": {"view": "term", "controller": "shell", "session:host": "juliansiddig@julians-mac-mini", "session:tmux": "renner"}}
    ],
    "rootnode": {"flexDirection": "row", "size": 10, "children": [
      {"flexDirection": "column", "size": 10, "data": {"blockindex": 0}},
      {"flexDirection": "column", "size": 10, "children": [
        {"flexDirection": "row", "size": 7, "data": {"blockindex": 1}},
        {"flexDirection": "row", "size": 3, "data": {"blockindex": 2}},
        {"flexDirection": "row", "size": 5, "data": {"blockindex": 9}}
      ]}
    ]}
  }]
}`

func TestImportSnapshotTab(t *testing.T) {
	ctx := initTestStore(t)
	snap, err := ParseWorkspaceSnapshot([]byte(testSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	tabId, err := createTab(ctx, ws.OID, "", true, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := ImportSnapshotTab(ctx, tabId, snap.Tabs[0]); err != nil {
		t.Fatalf("import: %v", err)
	}
	tab, _ := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if tab.Name != "Crew" || len(tab.BlockIds) != 3 {
		t.Fatalf("tab name %q, %d blocks", tab.Name, len(tab.BlockIds))
	}
	byId := map[string]*waveobj.Block{}
	for _, id := range tab.BlockIds {
		b, _ := wstore.DBMustGet[*waveobj.Block](ctx, id)
		byId[id] = b
	}
	layoutId, _ := GetLayoutIdForTab(ctx, tabId)
	ls, _ := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutId)
	raw, _ := json.Marshal(ls.RootNode)
	var root struct {
		Id            string `json:"id"`
		FlexDirection string `json:"flexDirection"`
		Children      []struct {
			Id       string            `json:"id"`
			Data     map[string]string `json:"data"`
			Children []struct {
				Id   string            `json:"id"`
				Size float64           `json:"size"`
				Data map[string]string `json:"data"`
			} `json:"children"`
		} `json:"children"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatal(err)
	}
	if root.FlexDirection != "row" || len(root.Children) != 2 || root.Id == "" {
		t.Fatalf("root shape wrong: %s", raw)
	}
	left := byId[root.Children[0].Data["blockId"]]
	if left == nil || left.Meta["session:tmux"] != "siddig" {
		t.Errorf("left pane should be siddig: %s", raw)
	}
	right := root.Children[1].Children
	if len(right) != 2 { // the leaf pointing at block 9 (out of range) is dropped
		t.Fatalf("right column should have 2 panes, got %d: %s", len(right), raw)
	}
	if byId[right[0].Data["blockId"]].Meta["session:tmux"] != "lee" || right[0].Size != 7 {
		t.Errorf("top-right should be lee at size 7: %s", raw)
	}
	if byId[right[1].Data["blockId"]].Meta["session:tmux"] != "renner" || right[1].Size != 3 {
		t.Errorf("bottom-right should be renner at size 3: %s", raw)
	}
	if ls.FocusedNodeId != right[1].Id {
		t.Errorf("focus should be on renner's node")
	}
}

func TestParseWorkspaceSnapshotRejects(t *testing.T) {
	for _, bad := range []string{
		`{}`, `not json`,
		`{"type":"terminus-workspace","version":2,"tabs":[{"blocks":[{}],"rootnode":{}}]}`,
		`{"type":"other","version":1,"tabs":[{"blocks":[{}],"rootnode":{}}]}`,
		`{"type":"terminus-workspace","version":1,"tabs":[]}`,
		`{"type":"terminus-workspace","version":1,"tabs":[{"blocks":[],"rootnode":{}}]}`,
	} {
		if _, err := ParseWorkspaceSnapshot([]byte(bad)); err == nil {
			t.Errorf("should reject %s", bad)
		}
	}
}
