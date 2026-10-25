# CLIa (AgentPet)

CLIa is an always-on-top desktop mascot for CLI coding agents. It receives local permission requests, shows an unobtrusive approval prompt, and returns the selected response without taking focus away from your active application.

## Requirements

- Windows (the current desktop integration targets Electron on Windows)
- Node.js 22 or newer
- npm 10 or newer

## Install and run

```powershell
npm ci
npm run build
npx electron .
```

For development, run the Vite renderer in one terminal and Electron in another:

```powershell
npm run dev:renderer
$env:VITE_DEV_SERVER_URL = "http://localhost:5173"
npx electron .
```

## CLI

After building, use the CLI with `npx clia` or install it globally from this repository.

```text
clia run <command> [...args]
clia wrap <command> [...args]
clia test
clia mock
clia hook claude
clia hook install-claude [--global]
```

`clia hook install-claude` adds the local PreToolUse hook to Claude Code settings. Restart Claude Code afterwards. If the mascot is unavailable, Claude Code falls back to its normal permission prompt.

## Architecture

- `src/main/` — Electron process, tray controls, and local WebSocket hub
- `src/renderer/` — React mascot and permission UI
- `src/cli/` — CLI wrapper, PTY handling, and Claude hook integration
- `src/shared/` — IPC/WebSocket protocol types
- `test/` — focused integration tests

The local WebSocket protocol is documented in [SPEC.md](SPEC.md).

## Quality checks

```powershell
npm run typecheck
npm test
npm run build
npm run verify
```
