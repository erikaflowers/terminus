# Terminus — WaveTerm Fork

Fork of [WaveTerm](https://github.com/wavetermdev/waveterm) for internal tool use. Renamed to **Terminus**.

## Build

### Prerequisites
- Go, Node.js 22+, Task (`brew install go-task go`); Zig only for Linux/Windows cross-compiles. The Mac Mini is the build hub.

### Commands
```bash
npm ci                 # deps (don't let npm rewrite the lockfile)
task dev               # Dev mode with HMR (quit the installed Terminus first: shared lock)
task build:backend --force && npm run build:prod && rm -rf make/ && \
  CSC_IDENTITY_AUTO_DISCOVERY=false npm exec electron-builder -- -c electron-builder.config.cjs -p never
task generate          # after changing Go service methods / meta keys
```
**Never `task package`** (race condition ships an app with no window). See BUILD.md for releases (`terminus-v*` tags).

### Logs
- Frontend: Chrome DevTools (Cmd+Option+I)
- Backend: `~/Library/Application Support/terminus-dev/waveapp.log` (dev mode)

## Directory Mapping (macOS)

| What | Production | Dev Mode |
|------|-----------|----------|
| Config | `~/.config/terminus/` | `~/.config/terminus-dev/` |
| Data | `~/Library/Application Support/terminus/` | `~/Library/Application Support/terminus-dev/` |
| Cache | `~/Library/Caches/terminus/` | `~/Library/Caches/terminus-dev/` |
| Temp sockets | `/tmp/terminus-{uid}/` | `/tmp/terminus-{uid}/` |

Original Wave uses `waveterm` in all these paths. Both apps coexist.

## Rename Status

### Changed (user-facing identity)
- `package.json` — name, productName, appId (`dev.matilda.terminus`)
- `electron-builder.config.cjs` — entitlement strings, publish removed
- `emain/emain-platform.ts` — dir prefix, envPaths, app.setName
- `emain/emain-menu.ts` — "About Terminus"
- `emain/emain.ts` — quit dialog, log messages
- `emain/updater.ts` — notification title/body
- `pkg/wavebase/wavebase.go` — appBundle, /tmp socket path
- `cmd/server/main-server.go` — log prefix, version/dir log messages
- `Taskfile.yml` — APP_NAME, dev paths, bucket refs removed

### NOT Changed (intentionally)
- **Go module path** (`github.com/wavetermdev/waveterm`) — 970+ imports, internal only
- **WAVETERM_* env vars** — internal IPC, 15+ files + 6 shell scripts, zero user visibility
- **Remote SSH paths** (`~/.waveterm/`) — breaking change for existing hosts with wsh
- **WAVESRV-ESTART protocol marker** — parsed by both TS and Go, must match
- **Shell integration env vars** — WAVETERM_SWAPTOKEN, _WAVETERM_SI_*, etc.

## Architecture

```
Electron (React + TypeScript + Vite)
    ↕ WebSocket (localhost, random auth key)
Go Backend (wavesrv — SQLite, SSH, terminal emulation)
    ↕ wsh CLI (Wave Shell — RPC to server)
```

## Key Files

| File | Purpose |
|------|---------|
| `emain/emain-platform.ts` | App identity, data/config path resolution |
| `pkg/wavebase/wavebase.go` | Go constants, cache/socket paths |
| `emain/emain.ts` | App lifecycle, quit handling |
| `emain/emain-wavesrv.ts` | Go server process management |
| `pkg/wconfig/` | Config management with file watchers |
| `schema/` | JSON schemas for settings, AI presets, widgets |

## Conventions (since 0.14.2)

- **Shell strings:** every value interpolated into a shell command goes through `frontend/util/shellquote.ts` (`shellQuote`, `shellJoin`, `sshCommand`); tmux session names must pass `isSafeSessionName`. `getApi().execCommand` is `/bin/sh -c` with a 10 s timeout.
- **Never delete a block to move it.** Use the `detach` layout action (`wcore.MoveBlockToTab`); `delete`/`closeNode` calls `DeleteBlock`, which kills the process.
- **Terminus launched from Finder has no `LANG`:** tmux (and others) mangle control characters in output. Use printable separators when parsing command output.
- **tmux attach (0.15.0, Home Sessions):** never write an auto-reconnect init script and never `new-session -A`/`exec` for attaching. Use `attachPane()` in `frontend/app/block/sessionrestore.ts`: it types an attach-only command (`tmux attach-session -t =<name>`, via ssh to home) at the pane's prompt, so detaching returns to the pane's own shell. Sessions are started on home (`launchAgentAtHome`, dotfiles `matildabot`). Home = Crew's `remoteHost`.
- Fork meta keys live in `pkg/waveobj/wtypemeta.go` (`agent:*`, `session:*`, `frame:collapsed`/`prevsize`, `term:bgcolor`); run `task generate` after adding one.

## Status

Current release **0.15.0** (`terminus-v0.15.0`, 2026-10-06): Home Sessions (the Mini is the session server). What's next: ROADMAP.md → "Next". Code review and remaining lows: `docs/REVIEW-2026-09-26.md`.
