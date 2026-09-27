# Terminus Roadmap

Internal roadmap for Terminus (WaveTerm fork), the multi-agent CLI multiplexer.

Legend: ✅ Done | 🔧 In Progress | 🔷 Planned

---

## Next (as of 0.14.3, 2026-09-27)

Terminus is stable for daily use across the Air, the Studio and the Mini. When work resumes, in rough order:

1. 🔷 **UI cleanup.** Samantha's list of pane-header buttons she doesn't use (candidates: settings cog vs. right-click, Add to Layout, Terminal/Wave App switch, AI sparkles, multi-input indicator, collapse), plus any remaining connection/restart quirks.
2. 🔷 **Upstream Wave catch-up.** 197 commits behind (v0.14.2 to v0.14.5 + 63 unreleased; ~94 are dependency bumps). A trial merge shows 25 conflicting files, mostly block header/frame, tab bar, term model, emain. Overlaps to reconcile: upstream's Claude-active icon vs. our Claude Status, opt-in split buttons vs. our header buttons, tab/block badges, ProcessViewer vs. Dev Servers. Worth getting: vertical tab bar, xterm.js v6, drag-drop file paths, quake mode, `wsh tab list/move`, durable-session and OSC 8 fixes, `sharp` declared. Do it on its own sprint branch.
3. 🔷 **Find-and-follow.** The Mac Mini keeps the latest workspace snapshot (building on Clone Workspace + Session Restore), and any machine that opens Terminus offers "continue where you were". It's the "Matilda knows where I am" model: the Mini holds the work, every screen is a view onto it.
4. 🔷 **Windows box.** Build Terminus for Windows (the Zig cross-compile targets exist; untested), and extend Clone Workspace to it (OpenSSH on Windows, different data dir path).
5. 🔷 **Review lows.** About 45 low-severity items remain in [docs/REVIEW-2026-09-26.md](docs/REVIEW-2026-09-26.md).
6. 🔷 **Known issues.** The `layoutTree › compute move` test fails (it predates 0.14.2); moved panes keep `WAVETERM_TABID` from their original tab; Session Restore saves plain `ssh host` (put ports/jump hosts in `~/.ssh/config`); builds are ad-hoc signed (no notarization).

---

## v1.0 Beta (2026-03-12)

### Agent System
- ✅ Crew panel — agent list, remote config, avatar display
- ✅ Agent switcher dropdown with tmux session attach
- ✅ Agent color accents on pane headers
- ✅ Agent preferences persistence (theme, bgcolor per agent)
- ✅ ForceRestart pattern for reliable session switching
- ✅ Re-select same agent to force reconnect (broken pipe recovery)

### Remote / SSH
- ✅ Local vs remote tmux path resolution
- ✅ Auto-detect remote tmux path via SSH
- ✅ `getTmuxCmd()` centralized helper
- ✅ Remote tmux path override in crew panel UI

### Layout & UX
- ✅ Accordion collapse for panes (vertical stacking only)
- ✅ Settings opens as layout panel, not ephemeral modal
- ✅ Dev/prod app coexistence (separate Electron instance lock)

### Custom Panels
- ✅ Fleet Activity Log — agent session logger with SQLite backend
- ✅ Git Dashboard — repo scanner with fetch/pull/status
- ✅ Node Graph — tmux session topology visualizer
- ✅ Usage Dashboard — cost tracking
- ✅ Hopper — multi-agent prompt dispatch with relay chains

### Custom Panels (cont.)
- ✅ Web Stats — Plausible analytics dashboard (configurable)

### Settings & Preferences
- ✅ All user-specific paths elevated to configurable preferences
- ✅ Terminus section in Settings panel (repo path, agents path, GitHub org, Plausible)
- ✅ Native OS folder picker for path fields
- ✅ AI section hidden until in-app AI plan exists
- ✅ Cloud sync for layout/settings (machine-specific paths excluded)

### Cloud Sync
- ✅ Cloud sync BYOE — all endpoints and OAuth credentials are user preferences
- ✅ Cloud sync fields in Settings panel (Sync URL, Devices URL, OAuth ID, OAuth Secret)
- ✅ Electron main process reads prefs from agent-preferences.json (no hardcoded URLs)
- ✅ Backward compat with legacy oauth-credentials.json for migration

### Build & Infra
- ✅ Packaged app builds (ARM64 + x64 DMG)
- ✅ Terminus cube icon (dock, app bundle, DMG)
- ✅ wcloud endpoint warning instead of crash in dev mode
- ✅ README, BUILD, CONTRIBUTING rewritten for Terminus
- ✅ Marketing site at terminus.zerovector.design (site/ directory, Netlify deploy)

---

## v1.1 — Post-Beta Polish

### Pane Status Indicators
- 🔷 3-dot status in pane header: SSH / tmux / Claude Code
- 🔷 Detect agent mismatch (metadata vs actual tmux session)
- 🔷 Comment out unused ConnectionButton

### Accordion Collapse Refinements
- ✅ Minimum collapsed height = header bar height (pixel-aware) — 0.14.2
- 🔷 Collapse animation transition

### Upstream Merge
- 🔷 Cherry-pick Wave v0.14.2 bug fixes (zoom notifications, focus tracking)
- 🔷 Evaluate v0.14.2 badge system for agent status integration
- 🔷 Full upstream merge when conflict surface is manageable

### Session Restore (logged 2026-09-27, Samantha) — ✅ shipped in 0.14.2; Clone Workspace in 0.14.3
**Problem:** after quitting/restarting Terminus, every agent pane comes back as a plain local shell. Today that means retyping `macstudio` + `tmux attach -t siddig` (Studio), and `macmini` + `tmux attach -t lee` / `renner` (Mini), in each pane, every restart. The pane should remember where it was.
**Want:** on reopen, each pane either reconnects by itself or shows an indicator — "was: ssh mac-studio-2 → tmux siddig · ⏎ reconnect" — one click/keypress, no retyping.
- 🔷 **Record** what a pane was connected to. Shell integration already reports every command line (OSC 16162 `C`, `cmd64`), so Terminus can see `ssh <host>` / an alias like `macstudio` start in a pane; the remote tmux session name isn't visible from the local shell, so either parse `ssh host -t "tmux attach -t X"` one-liners or let the pane header say "Remember session…" (host + tmux session) once.
- 🔷 **Store** it per pane as block meta (e.g. `session:host`, `session:tmux`), which survives restarts with the layout.
- 🔷 **Restore:** on app start, a pane with a remembered session shows a reconnect banner (⏎ / click) or auto-reconnects (setting). Reconnect = the init-script path we already have: `exec ssh -t <host> tmux new-session -A -s <name>` (quoted via `shellquote.sshCommand`, attach-or-create, Enter re-attaches after a drop). Per-pane host, unlike Crew's single `remoteHost`.
- 🔷 **Also evaluate** Wave's native answer: SSH panes via Terminus's own connection system (`connection:` meta) + `term:durable`, where the job manager keeps the remote process alive across app restarts and re-attaches automatically (the durable socket bug is fixed in `sprint/terminus-stabilize`). The fork removed the connection selector (0bb62e61), so this needs a UI decision first.
- 🔷 Pairs with pane moving (`feature/pane-move`): a moved pane keeps its remembered session.

### Agent Workflow
- 🔷 Hopper payload relay — clean end-to-end test
- 🔷 Relay instruction tuning (agent refusal edge cases)
- ✅ Agent session auto-restart on disconnect — 0.14.2 (attach-or-create + Enter re-attaches; Session Restore)

---

## v1.2 — Fleet Intelligence

### Status & Monitoring
- 🔷 Agent heartbeat / liveness detection
- 🔷 Fleet-wide git status summary
- 🔷 Session duration and idle tracking

### Automation
- 🔷 Scheduled relay chains (cron-style prompt dispatch)
- 🔷 Agent task queue with priority
- 🔷 Batch operations across agents

### UX
- 🔷 Tab badges for agent activity (upstream badge system)
- 🔷 Keyboard shortcuts for agent switching
- 🔷 Layout templates (save/restore pane arrangements)

---

## Ideas / Backlog

- Import/export tab layouts
- Command palette for agent operations
- Agent-specific keybindings
- Mobile companion for fleet monitoring
- Webhook integrations for relay chains
