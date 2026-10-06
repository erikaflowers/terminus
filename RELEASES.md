# Terminus Releases

Tags are `terminus-v<version>` (the repo also carries upstream Wave's `v0.14.x` tags).

## 0.15.0 — 2026-10-06 (`terminus-v0.15.0`): Home sessions

The Mac Mini is home: it holds the tmux/agent sessions and every Terminus is a window onto it.

- **Panes never connect on their own.** The old auto-reconnect init script (`exec ssh … tmux new-session -A`) is gone; it trapped panes (Enter replayed it, so you couldn't get out) and created empty sessions. Attaching types an attach-only command at the pane's prompt (exact `=name`, never creates), so detaching or a dropped connection lands in the pane's own local shell.
- **Session bar.** A pane that remembers a session shows `● heavy @ julians-mac-mini  [Attach] [Pick ▾] ×` while it isn't attached. If the session isn't running it says so and, for crew agents, offers **Launch**. New panes and splits show `Pick a session on <home> ▾` (× hides it per pane: `session:off`).
- **Session picker** (header server button, or Pick ▾): what's running on home, with agent colors, a filled dot when someone is attached and the client count.
  - **New session:** the home machine's `agent-*` folders that aren't running; one click = `launch <agent>` (detached tmux in the agent folder running `clauded`) + attach.
  - **`+` second copy** on a running agent: `<agent>-<project>`, like `launch lee newsite`.
  - **🤖 Matildabot:** a numbered throwaway utility droid (`matildabot-NNN`, dotfiles `scripts/matildabot`); `/exit` ends it and the pane forgets it.
- **Home** is Crew's remote host. Crew attach, the per-pane agent picker and Clone Workspace use the new path; old remembered panes and old init scripts are migrated (before the pane's shell first starts).
- Removed: the pane-header **Detach to tmux** button (the picker's New session replaces it).

## 0.14.3 — 2026-09-27 (`terminus-v0.14.3`)

- **Clone Workspace to another Mac** (tab menu) over ssh into the other Terminus's `workspace-inbox`, or via clipboard. The exact layout tree is rebuilt in a new window; remembered sessions reconnect, and sessions hosted on the receiving Mac attach locally.
- Fix: "new window not created" error after Send to New Window / Open Workspace had succeeded (a wait that could never match; removed). Emptied source tabs now close, and cloned snapshots are acknowledged.

## 0.14.2 — 2026-09-27 (`terminus-v0.14.2`)

- **Send panes to other tabs and windows** without reconnecting (a real move; new non-destructive `detach` layout action).
- **Session Restore:** panes remember `ssh host → tmux session` and reconnect on every start (incl. after Cmd-Q).
- **Mouse-flood fix:** stale mouse/focus/cursor modes are reset at the shell prompt, on process start/stop, and after replay; mouse reports are dropped at the prompt and never broadcast in multi-input.
- **18 high/medium review fixes** ([docs/REVIEW-2026-09-26.md](docs/REVIEW-2026-09-26.md)): web-block capture locked down, cloud sync allowlist/containment/no secrets/no echo, attach-or-create tmux, quoting everywhere, durable SSH job socket, collapse math, settings wipe, per-tab prefs, Hopper relay, Dev Servers/Git Dashboard/Visualizer/Usage fixes, no Wave telemetry.
- Undeclared fork meta keys (`agent:*`, `frame:collapsed`/`prevsize`, `term:bgcolor`, `session:*`) are now in the schema.

### Known
- `frontend/layout/tests/layoutTree.test.ts › compute move` fails (it already failed before 0.14.2).
- A moved pane's shell keeps `WAVETERM_TABID` from where it started (affects `wsh` commands that target "this tab").

## Beta 1 — 2026-03-14

First beta build for external testers.

### Includes
- Agent system with 16 pre-defined crew members
- Crew Manager, Git Dashboard, Fleet Log, Hopper, Usage Dashboard, Web Stats, Dev Servers panels
- Configurable user preferences (paths, API keys) via Settings panel
- Accordion collapse for vertical pane stacking
- Local and remote SSH/tmux agent session support
- Cloud sync for settings across machines
- Terminus cube branding (icons, dock, DMG)
- ARM64 and x64 macOS DMGs

### Known Limitations
- AI chat panel disabled (no in-app AI plan yet)
- Wave v0.14.2 upstream fixes not yet merged
- No auto-update — manual DMG install required
- macOS only (Linux/Windows untested)
