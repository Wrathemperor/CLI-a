import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import * as pty from "node-pty";
import WebSocket, { type RawData } from "ws";
import {
  type CliToMascotMessage,
  type PermissionRequestMessage,
  type SessionState,
  type UnregisterMessage
} from "../shared/protocol";
import { CliStreamParser, type DetectedPermissionRequest } from "./parser";

const websocketPort = Number(process.env.CLIA_WS_PORT ?? 49152);
if (!Number.isInteger(websocketPort) || websocketPort < 1 || websocketPort > 65535) {
  throw new Error("CLIA_WS_PORT must be a valid TCP port.");
}
const WEBSOCKET_URL = `ws://127.0.0.1:${websocketPort}`;
const DEBUG_LOG_PATH = path.join(process.cwd(), "clia-debug.log");
const MAX_RECONNECT_DELAY_MS = 5000;
const SHUTDOWN_DELIVERY_TIMEOUT_MS = 1500;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  ".com",
  ".exe",
  ".bat",
  ".cmd"
]);

function writeDebugLog(message: string): void {
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("[clia-wrap] Failed to write debug log:", error);
  }
}

const [command, ...commandArgs] = process.argv.slice(2);
if (!command) {
  console.error("Usage: pet-wrap <command> [...args]");
  process.exit(1);
}

function resolveWindowsExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): string {
  if (process.platform !== "win32" || path.isAbsolute(executable)) {
    return executable;
  }

  if (executable.includes("\\") || executable.includes("/")) {
    const localPath = path.resolve(cwd, executable);
    if (!path.extname(localPath)) {
      const pathExtensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) =>
          WINDOWS_EXECUTABLE_EXTENSIONS.has(extension.toLowerCase())
        );
      const extensionMatch = pathExtensions
        .map((extension) => `${localPath}${extension.toLowerCase()}`)
        .find((candidate) => existsSync(candidate));
      if (extensionMatch) {
        return extensionMatch;
      }
    }
    if (existsSync(localPath)) {
      return localPath;
    }
    throw new Error(`Command not found: ${executable}`);
  }

  const lookup = spawnSync("where.exe", [executable], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true
  });
  if (lookup.error) {
    throw new Error(`Unable to resolve command "${executable}": ${lookup.error.message}`);
  }
  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    throw new Error(`Command not found on PATH: ${executable}`);
  }
  const pathExtensions = new Set(
    (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => extension.toLowerCase())
      .filter((extension) => WINDOWS_EXECUTABLE_EXTENSIONS.has(extension))
  );
  const resolved = lookup.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.length > 0 &&
        pathExtensions.has(path.extname(candidate).toLowerCase())
    );
  if (!resolved) {
    throw new Error(`Command not found on PATH: ${executable}`);
  }
  return resolved;
}

function quoteWindowsCommandArgument(argument: string): string {
  return `"${argument.replace(/"/g, '\\"')}"`;
}

function getPtyCommand(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): { file: string; args: string[] | string } {
  if (process.platform !== "win32") {
    return { file: executable, args };
  }

  const resolvedExecutable = resolveWindowsExecutable(executable, cwd, env);
  if (!/\.(?:bat|cmd)$/i.test(resolvedExecutable)) {
    return { file: resolvedExecutable, args };
  }

  const commandShell =
    env.ComSpec ??
    path.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const commandLine = [
    `"${resolvedExecutable}"`,
    ...args.map(quoteWindowsCommandArgument)
  ].join(" ");
  return {
    file: commandShell,
    args: `/d /s /c "${commandLine}"`
  };
}

const sessionId = randomUUID();
const sessionCommand = [command, ...commandArgs].join(" ");
const terminalName = process.env.TERM || "xterm-color";
let ptyCommand: { file: string; args: string[] | string };
try {
  ptyCommand = getPtyCommand(command, commandArgs, process.cwd(), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const terminal = pty.spawn(ptyCommand.file, ptyCommand.args, {
  name: terminalName,
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  cwd: process.cwd(),
  env: process.env
});

let socket: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let shutdownTimer: NodeJS.Timeout | undefined;
let reconnectDelay = 250;
let currentState: SessionState = "IDLE";
let pendingRequest: PermissionRequestMessage | undefined;
let shutdownMessage: UnregisterMessage | undefined;
let targetExitCode = 0;
let shuttingDown = false;
let shutdownDelivered = false;
function send(message: CliToMascotMessage): void {
  const activeSocket = socket;
  if (activeSocket?.readyState !== WebSocket.OPEN) {
    writeDebugLog(
      `WebSocket send deferred: type=${message.type}; readyState=${activeSocket?.readyState ?? "disconnected"}`
    );
    return;
  }

  activeSocket.send(JSON.stringify(message), (error?: Error) => {
    if (!error) {
      return;
    }
    writeDebugLog(
      `WebSocket send failed: type=${message.type}; error=${JSON.stringify(error.message)}`
    );
    if (socket === activeSocket && !shutdownDelivered) {
      activeSocket.terminate();
    }
  });
}

function setState(state: SessionState): void {
  if (currentState === state) {
    return;
  }
  currentState = state;
  send({ type: "STATE_UPDATE", sessionId, state });
}

function sendSessionSnapshot(): void {
  send({
    type: "REGISTER",
    sessionId,
    command: sessionCommand,
    pid: terminal.pid,
    cwd: process.cwd()
  });
  send({ type: "STATE_UPDATE", sessionId, state: currentState });
  if (pendingRequest) {
    send(pendingRequest);
  }
  if (shutdownMessage) {
    send(shutdownMessage);
    finishShutdown();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || shutdownDelivered) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

function handleWebSocketMessage(data: RawData): void {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    console.error("Ignoring invalid WebSocket message:", error);
    return;
  }

  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "PERMISSION_RESPONSE"
  ) {
    writeDebugLog(
      `Incoming PERMISSION_RESPONSE: ${JSON.stringify({
        sessionId: "sessionId" in message ? message.sessionId : undefined,
        requestId: "requestId" in message ? message.requestId : undefined,
        payload: "payload" in message ? message.payload : undefined,
        expectedSessionId: sessionId,
        expectedRequestId: pendingRequest?.requestId
      })}`
    );
  }

  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "PERMISSION_RESPONSE" ||
    !("sessionId" in message) ||
    typeof message.sessionId !== "string" ||
    !("requestId" in message) ||
    typeof message.requestId !== "string" ||
    !("payload" in message) ||
    typeof message.payload !== "string"
  ) {
    return;
  }

  if (
    message.sessionId !== sessionId ||
    !pendingRequest ||
    message.requestId !== pendingRequest.requestId
  ) {
    writeDebugLog(
      `Ignored PERMISSION_RESPONSE: sessionMatch=${message.sessionId === sessionId}; pendingRequest=${Boolean(pendingRequest)}; requestMatch=${message.requestId === pendingRequest?.requestId}`
    );
    return;
  }

  writeDebugLog(
    `Received PERMISSION_RESPONSE: requestId=${message.requestId}; payload=${JSON.stringify(message.payload)}`
  );
  const isAntigravityPrompt = pendingRequest.options.some((option) =>
    option.label.startsWith("Always (Persist)")
  );
  const isClaudeTuiPrompt = pendingRequest.options.some((option) =>
    option.label.startsWith("Yes, and don't ask again [2]")
  );
  const isCodexTuiPrompt = pendingRequest.options.some((option) =>
    option.label.startsWith("Always Allow [2 / p]")
  );
  const tuiSelection = isAntigravityPrompt || isClaudeTuiPrompt
    ? message.payload.match(/^([1-4])\r?$/)
    : undefined;
  const codexTuiPayload = isCodexTuiPrompt
    ? message.payload === "y"
      ? "\r"
      : message.payload
    : undefined;
  const payload =
    tuiSelection?.[1] ??
    codexTuiPayload ??
    (message.payload === "\u001b"
      ? message.payload
      : message.payload.endsWith("\r")
        ? message.payload
        : `${message.payload}\r`);
  console.error(
    `[clia-wrap] Writing payload to PTY: ${JSON.stringify(payload)}`
  );
  writeDebugLog(
    `Writing decision bytes to PTY: text=${JSON.stringify(payload)}; hex=${Buffer.from(payload, "utf8").toString("hex")}; antigravity=${isAntigravityPrompt}; codexTui=${isCodexTuiPrompt}`
  );
  terminal.write(payload);
  pendingRequest = undefined;
  parser.reset();
  setState("WORKING");
  if (tuiSelection || (isCodexTuiPrompt && payload === "p")) {
    setTimeout(() => {
      console.error("[clia-wrap] Confirming TUI selection with Enter.");
      writeDebugLog(
        `Writing delayed TUI Enter: text=${JSON.stringify("\r")}; hex=0d`
      );
      terminal.write("\r");
    }, 50);
  }
}

function connect(): void {
  if (shutdownDelivered) {
    return;
  }

  const nextSocket = new WebSocket(WEBSOCKET_URL);
  socket = nextSocket;
  nextSocket.on("open", () => {
    reconnectDelay = 250;
    sendSessionSnapshot();
  });
  nextSocket.on("message", handleWebSocketMessage);
  nextSocket.on("close", () => {
    if (socket === nextSocket) {
      socket = undefined;
    }
    if (!shutdownDelivered) {
      scheduleReconnect();
    }
  });
  nextSocket.on("error", (error) => {
    console.error("AgentPet WebSocket connection error:", error.message);
  });
}

function handlePermissionRequest(
  request: DetectedPermissionRequest
): void {
  const message: PermissionRequestMessage = {
    type: "PERMISSION_REQUEST",
    sessionId,
    ...request
  };
  pendingRequest = message;
  setState("WAITING_PERMISSION");
  writeDebugLog(
    `Sending PERMISSION_REQUEST: requestId=${message.requestId}; readyState=${socket?.readyState ?? "disconnected"}; summary=${JSON.stringify(message.summary)}`
  );
  send(message);
}

const parser = new CliStreamParser({
  command: sessionCommand,
  onPermissionRequest: handlePermissionRequest,
  onIdle: () => {
    if (!pendingRequest) {
      setState("IDLE");
    }
  }
});

function finishShutdown(): void {
  shutdownDelivered = true;
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const connectedSocket = socket;
  const exitAfterFlush = (): void => {
    process.stdout.write("", () => process.exit(targetExitCode));
  };

  if (connectedSocket?.readyState === WebSocket.OPEN) {
    connectedSocket.once("close", () => {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
      exitAfterFlush();
    });
    connectedSocket.close();
    shutdownTimer = setTimeout(() => {
      shutdownTimer = undefined;
      connectedSocket.terminate();
      exitAfterFlush();
    }, SHUTDOWN_DELIVERY_TIMEOUT_MS);
  } else {
    socket?.terminate();
    exitAfterFlush();
  }
  process.exitCode = targetExitCode;
}

function handleExit(exitCode: number): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  targetExitCode = exitCode;
  shutdownMessage = { type: "UNREGISTER", sessionId, exitCode };

  process.stdin.off("data", onStdinData);
  process.stdout.off("resize", onResize);
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  if (socket?.readyState === WebSocket.OPEN) {
    send(shutdownMessage);
    finishShutdown();
    return;
  }

  shutdownTimer = setTimeout(finishShutdown, SHUTDOWN_DELIVERY_TIMEOUT_MS);
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  }
}

function onStdinData(data: Buffer): void {
  const input = data.toString("utf8");
  if (pendingRequest && /[\r\n\u001b1-4]/.test(input)) {
    pendingRequest = undefined;
    parser.reset();
    setState("WORKING");
  }
  terminal.write(data);
}

function onResize(): void {
  terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24);
}

if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", onStdinData);
process.stdout.on("resize", onResize);

const dataSubscription = terminal.onData((data) => {
  process.stdout.write(data);
  if (!pendingRequest) {
    setState("WORKING");
  }
  parser.push(data);
});

const exitSubscription = terminal.onExit(({ exitCode }) => {
  dataSubscription.dispose();
  exitSubscription.dispose();
  void handleExit(exitCode);
});

connect();
