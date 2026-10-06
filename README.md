# Terminus

**A mission control terminal for AI agent crews.** Built on [Wave Terminal](https://github.com/wavetermdev/waveterm) (forked at v0.14.1). Current release: **0.15.0** (tag `terminus-v0.15.0`, see [RELEASES.md](RELEASES.md)).

Terminus is an Electron-based terminal multiplexer designed for orchestrating multiple AI agents running in parallel tmux sessions. Each agent gets its own identity, terminal theme, persistent session, and avatar — all managed from a single unified interface.

---

## Features

### Agent System

Every terminal pane can be assigned to an agent. The header shows the agent's name, role, avatar, and a colored accent border. Switching agents is instant via header dropdown — the pane restarts as a clean shell and attaches that agent's tmux session on the home machine (see Home Sessions).

- 16 pre-defined agents with unique colors, roles, and avatars
- Per-agent terminal themes and background colors
- Per-agent preferences persist across sessions
- Local and remote (SSH) tmux session support with auto-detected tmux paths

### Home Sessions (0.15.0)

The Mac Mini is home: it holds every tmux/agent session, and each Terminus is a window onto it. Home is Crew's remote host (Crew settings).

- **Nothing connects by itself.** A pane remembers the session it last showed. While it isn't attached, a bar offers `● heavy @ julians-mac-mini  [Attach] [Pick ▾] ×`. Attach types an attach-only command at the pane's prompt; Ctrl-b d (or a dropped connection) leaves you in the pane's own shell, and Enter never reconnects.
- **Session picker** (the header's server button, or Pick ▾): everything running on home. Dot = agent color, filled = someone is attached (number = clients), outline = this pane's last session.
  - **New session:** agents (home's `agent-*` folders) not running yet; one click runs `launch <agent>` there and attaches.
  - **`+`** on a running agent: a second copy, `<agent>-<project>`.
  - **🤖 matildabot:** a numbered throwaway droid for a one-off chore; `/exit` and it's gone.
- **New panes and splits** offer `Pick a session on <home> ▾`; × hides it for that pane.

### Panes Follow You (0.14.2 / 0.14.3)

Your work lives in tmux on your machines; Terminus panes are windows onto it. These features make a pane's session portable:

- **Move a pane to another tab or window.** Right-click a pane header (or its cog): **Send to Tab ▸** [tabs in this window…, New Tab], **Send to Window ▸** [each other window ▸ its tabs…, New Tab], **Send to New Window**. It's a real move: the pane keeps its id, so its process (shell, ssh, tmux) keeps running untouched. Nothing reconnects. A tab emptied by a move closes (and so does its window, if it was the last tab).
- **Session Restore** (0.14.2) was replaced in 0.15.0 by Home Sessions: panes remember their session but no longer reconnect on their own.
- **Clone Workspace to another Mac.** Right-click a tab: **Clone Workspace to ▸** [your other Macs online in Tailscale], **Copy Workspace Snapshot**, **Open Workspace from Clipboard**. The snapshot carries the window's tabs, the exact split layout and sizes, and each pane's settings. It's delivered over ssh into Terminus's `workspace-inbox` on the other Mac, which asks "Open workspace from …?" (also at launch, if it arrived while Terminus was closed). Remembered sessions arrive as the pane's session bar (nothing auto-connects); a session hosted on the receiving Mac is offered locally.
  - On recent macOS, Terminus's own `ssh` needs the **Local Network** permission once per Mac; the prompt names "ssh-keygen wrapper".
  - Sending uses key-based ssh between your Macs (Tailscale names), with the ssh user taken from your remembered sessions.

### Reliability

- **No more mouse floods.** When tmux/ssh dies with mouse reporting on, Terminus resets stale terminal modes when the shell prompt returns, when a pane's process starts or stops, and after history replay, so scrolls are no longer typed into zsh as escape codes.
- Attaching never creates a session (exact `=name` match), and a pane always falls back to its own local shell.
- Hardened after a full code review (Fable 5.1 + Opus 5.5 verification, [docs/REVIEW-2026-09-26.md](docs/REVIEW-2026-09-26.md)): shell quoting everywhere (`frontend/util/shellquote.ts`), web blocks can't capture screen/audio, cloud sync is allowlisted and never uploads secrets, Dev Servers only kills the process it shows, and more.
- **Privacy:** no telemetry or pings to Wave's servers; auto-update is off (there is no Terminus update feed).

### Panels

Terminus includes several custom sidebar panels beyond the terminal:

| Panel | Description |
|-------|-------------|
| **Crew Manager** | Live agent status, avatars, tmux session control (attach/launch/kill) |
| **Git Dashboard** | Repo scanner with branch, status, commit info, fetch/pull actions |
| **Fleet Activity Log** | Agent session logger with SQLite backend, conversation search |
| **Hopper** | Multi-agent prompt dispatch with relay chains, drafts, macros |
| **Usage Dashboard** | API cost tracking |
| **Web Stats** | Plausible analytics dashboard (configurable API key + site) |
| **Dev Servers** | Active dev server monitor (ports 3000-9999) with kill/open |
| **Node Graph** | Tmux session topology visualizer |

### Layout

- Block-based tiling layout (inherited from Wave)
- Accordion collapse for vertical pane stacking
- Settings opens as a layout panel, not a modal
- Dev and production app can run simultaneously (separate Electron instance locks)

### User Preferences

All user-specific paths and credentials are configurable in Settings (no hardcoded paths):

- **Repo Base Path** — root directory for project scanning (git dashboard, dev servers)
- **Agents Path** — path to agent repo (avatars, crew working directories)
- **GitHub Org** — for commit links in fleet log
- **Plausible API Key / Site ID** — for web stats panel
- **Cloud Sync URL / Devices URL** — for cross-machine sync (BYOE)
- **Cloud OAuth Client ID / Secret** — Google OAuth credentials for cloud sync
- Path fields include native OS folder picker

Preferences are stored in `~/.config/terminus/agent-preferences.json` (prod) or `~/.config/terminus-dev/agent-preferences.json` (dev).

### Cloud Sync (BYOE)

Terminus supports optional cloud sync to keep layout, settings, and widget config in sync across machines. Cloud sync is fully **Bring Your Own Endpoint** — all API URLs and OAuth credentials are user-configurable in Settings. No backend is baked in.

To enable cloud sync:
1. Deploy your own sync backend (or use a hosted one)
2. Set up a Google OAuth 2.0 client (console.cloud.google.com)
3. Fill in the four cloud sync fields in Settings → Terminus:
   - **Cloud Sync URL** — your sync API endpoint
   - **Cloud Devices URL** — your devices API endpoint
   - **Cloud OAuth Client ID** — Google OAuth client ID
   - **Cloud OAuth Client Secret** — Google OAuth client secret
4. Sign in via the Cloud Sync section in Settings

Machine-specific paths (repo base, agents path) are intentionally excluded from sync. Only `settings`, `connections` and `widgets` are synced (allowlisted on both push and pull); secret-looking keys (`*apitoken*`, `*secret*`, `*password*`, …) are stripped before upload and kept locally on pull; a startup pull never overwrites a local file that is newer than the cloud copy.

---

## Getting Started

### Prerequisites

- macOS (ARM64 or x64), Linux, or Windows
- [tmux](https://github.com/tmux/tmux) installed and in PATH

### Install

Download the latest DMG from the releases page, or build from source (see [BUILD.md](BUILD.md)).

### First Run

1. Open Terminus
2. Go to **Settings** (gear icon in sidebar)
3. Fill in the **Terminus** section:
   - **Repo Base Path** — where your project repos live
   - **Agents Path** — where agent directories and portraits are
4. Open the **Crew** panel to see agents and manage tmux sessions
5. Click any terminal pane header to assign an agent

---

## Building from Source

See [BUILD.md](BUILD.md) for full instructions. Quick start:

```bash
git clone https://github.com/erikaflowers/terminus.git
cd terminus
npm install
task build:backend --force
npm run build:prod
npm exec electron-builder -- -c electron-builder.config.cjs -p never
```

Output: `make/Terminus-darwin-{arm64,x64}-<version>.{dmg,zip}` (ad-hoc signed, not notarized). Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip certificate lookup, and never use `task package` (see BUILD.md). Releases are tagged `terminus-v<version>`, because the upstream `v0.14.x` tags also exist in this repo.

---

## Key Files

| File | Purpose |
|------|---------|
| `frontend/app/store/agents.ts` | Agent registry, global config, preferences, ForceRestart |
| `frontend/app/view/waveconfig/settingsvisual.tsx` | Settings UI with Terminus section |
| `frontend/app/view/crew/crew.tsx` | Crew Manager panel |
| `frontend/app/view/gitdash/gitdash.tsx` | Git Dashboard panel |
| `frontend/app/view/fleetlog/fleetlog.tsx` | Fleet Activity Log panel |
| `frontend/app/view/hopper/hopper.tsx` | Hopper dispatch panel |
| `frontend/app/view/webstats/webstats.tsx` | Plausible analytics panel |
| `frontend/app/block/block.tsx` | Block registry (view type -> ViewModel) |
| `pkg/wconfig/defaultconfig/widgets.json` | Sidebar widget definitions |
| `emain/emain-ipc.ts` | Electron IPC handlers |
| `emain/emain-oauth.ts` | Cloud sync OAuth + BYOE endpoint config |
| `frontend/util/shellquote.ts` | Shell quoting (`shellQuote`, `sshCommand`, safe session names), tested against /bin/sh |
| `frontend/app/view/term/termwrap.ts`, `osc-handlers.ts` | Stale mouse/terminal mode resets (mouse-flood fix) |
| `frontend/app/block/blockmove.ts`, `pkg/wcore/blockmove.go` | Send pane to tab/window (non-destructive `detach` layout action) |
| `frontend/app/block/sessionrestore*.ts`, `sessionbutton.tsx` | Session Restore |
| `frontend/app/workspace/workspaceclone*.ts`, `pkg/wcore/workspaceimport.go`, `emain/emain-workspaceinbox.ts` | Clone Workspace (snapshot, send, inbox, import) |

---

## Upstream

Terminus is forked from [Wave Terminal](https://github.com/wavetermdev/waveterm), an open-source terminal for macOS, Linux, and Windows. All upstream features — SSH sessions, file preview, drag-and-drop blocks, `wsh` CLI — are preserved.

Forked at Wave v0.14.1-beta.0. Last synced: v0.14.1. As of 2026-09-26 upstream is at v0.14.5 plus 63 unreleased commits (197 ahead of the fork; a trial merge shows 25 conflicting files). The catch-up is planned; see [ROADMAP.md](ROADMAP.md).

---

## Marketing Site

The marketing site and documentation live at [terminus.zerovector.design](https://terminus.zerovector.design). Source is in the `site/` directory.

---

## License

Apache-2.0. See [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md) for dependency information.
