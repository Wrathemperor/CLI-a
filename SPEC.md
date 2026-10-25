# SPEC.md — AgentPet (Always-On-Top CLI Mascot Proxy)

## 1. Core Objective
An always-on-top, frameless, click-through desktop mascot window coupled with a CLI wrapper (`pet-wrap`) and hook script (`pet-hook`). When an attached terminal agent asks for user permission to run a tool or bash command, the mascot alerts the user in the corner of their screen with clickable action buttons ([Approve], [Deny], [Always]). Clicking a button resolves the CLI prompt in the background without stealing OS window focus from the user's active application.

## 2. Critical OS Window Rules
- `transparent: true`, `frame: false`, `alwaysOnTop: true` (level: `"screen-saver"`), `skipTaskbar: true`.
- **Non-Focus-Stealing:** Set `focusable: false` on the BrowserWindow (or use `win.showInactive()`) so clicking the mascot's Approve/Deny buttons NEVER steals keyboard focus from the user's active IDE or browser.
- **Dynamic Click-Through:** By default, `win.setIgnoreMouseEvents(true, { forward: true })` is enabled so clicks on transparent background pixels pass through to underlying windows. When the cursor hovers over interactive DOM elements (`.interactive-zone`), the renderer sends an IPC message `set-ignore-mouse-events: false`. On `mouseleave`, it restores `true`.

## 3. WebSocket IPC Protocol (`ws://127.0.0.1:49152`)
### CLI -> Mascot Server Messages:
- `REGISTER`: `{ type: "REGISTER", sessionId: string, command: string, pid: number, cwd: string }`
- `STATE_UPDATE`: `{ type: "STATE_UPDATE", sessionId: string, state: "IDLE" | "WORKING" | "WAITING_PERMISSION" | "ERROR" }`
- `PERMISSION_REQUEST`: `{ type: "PERMISSION_REQUEST", sessionId: string, requestId: string, toolName: string, summary: string, rawContext: string, options: Array<{ label: string, payload: string, style: "approve" | "deny" | "neutral" }> }`
- `UNREGISTER`: `{ type: "UNREGISTER", sessionId: string, exitCode: number }`

### Mascot Server -> CLI Messages:
- `PERMISSION_RESPONSE`: `{ type: "PERMISSION_RESPONSE", sessionId: string, requestId: string, payload: string }`