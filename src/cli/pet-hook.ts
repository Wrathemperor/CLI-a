import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket, { type RawData } from "ws";
import type {
  CliToMascotMessage,
  PermissionRequestMessage
} from "../shared/protocol";

const websocketPort = Number(process.env.CLIA_WS_PORT ?? 49152);
if (!Number.isInteger(websocketPort) || websocketPort < 1 || websocketPort > 65535) {
  throw new Error("CLIA_WS_PORT must be a valid TCP port.");
}
const WEBSOCKET_URL = `ws://127.0.0.1:${websocketPort}`;
const CONNECT_TIMEOUT_MS = 1000;
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

interface ClaudeHookInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  hook_event_name?: unknown;
  hookEventName?: unknown;
}

interface HookDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHookInput(): ClaudeHookInput | undefined {
  try {
    const rawInput = readFileSync(0, "utf8");
    const parsed: unknown = JSON.parse(rawInput);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const summaryKey: Record<string, string> = {
    Bash: "command",
    Edit: "file_path",
    Read: "file_path",
    Write: "file_path"
  };
  const preferredKey = summaryKey[toolName];
  const preferredValue = preferredKey ? toolInput[preferredKey] : undefined;
  if (typeof preferredValue === "string" && preferredValue.length > 0) {
    return preferredValue;
  }

  const firstString = Object.values(toolInput).find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return firstString ?? JSON.stringify(toolInput, null, 2);
}

function writeHookDecision(decision: HookDecision): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...decision
    }
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function sendMessage(
  socket: WebSocket,
  message: CliToMascotMessage
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(message), (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function runHook(): Promise<void> {
  const input = readHookInput();
  if (!input || !isRecord(input.tool_input)) {
    return;
  }

  const eventName = input.hook_event_name ?? input.hookEventName;
  if (
    eventName !== undefined &&
    eventName !== "PreToolUse" &&
    eventName !== "PermissionRequest"
  ) {
    return;
  }

  const sessionId =
    typeof input.session_id === "string" && input.session_id.length > 0
      ? input.session_id
      : randomUUID();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const toolName =
    typeof input.tool_name === "string" && input.tool_name.length > 0
      ? input.tool_name
      : "Tool";
  const toolInput = input.tool_input;
  const requestId = randomUUID();
  const permissionRequest: PermissionRequestMessage = {
    type: "PERMISSION_REQUEST",
    sessionId,
    requestId,
    toolName,
    summary: summarizeToolInput(toolName, toolInput),
    rawContext: JSON.stringify(toolInput, null, 2),
    options: [
      { label: "Approve", payload: "allow", style: "approve" },
      { label: "Deny", payload: "deny", style: "deny" }
    ]
  };

  const socket = new WebSocket(WEBSOCKET_URL);
  let registered = false;
  let settled = false;
  let connectTimer: NodeJS.Timeout | undefined;
  let responseTimer: NodeJS.Timeout | undefined;

  const finish = async (decision?: HookDecision): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    if (connectTimer) {
      clearTimeout(connectTimer);
    }
    if (responseTimer) {
      clearTimeout(responseTimer);
    }

    if (registered && socket.readyState === WebSocket.OPEN) {
      try {
        await sendMessage(socket, {
          type: "UNREGISTER",
          sessionId,
          exitCode: decision?.permissionDecision === "deny" ? 2 : 0
        });
      } catch {
        // A disconnected hub should not prevent Claude from using its fallback prompt.
      }
      socket.close();
    } else if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.terminate();
    }

    if (decision) {
      writeHookDecision(decision);
      process.exitCode = decision.permissionDecision === "deny" ? 2 : 0;
    }
  };

  connectTimer = setTimeout(() => {
    void finish();
  }, CONNECT_TIMEOUT_MS);

  socket.on("open", () => {
    if (settled) {
      socket.close();
      return;
    }
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }

    void (async () => {
      registered = true;
      await sendMessage(socket, {
        type: "REGISTER",
        sessionId,
        command: "claude-hook",
        pid: process.pid,
        cwd
      });
      await sendMessage(socket, {
        type: "STATE_UPDATE",
        sessionId,
        state: "WAITING_PERMISSION"
      });
      await sendMessage(socket, permissionRequest);
      responseTimer = setTimeout(() => {
        void finish();
      }, RESPONSE_TIMEOUT_MS);
    })().catch(() => {
      void finish();
    });
  });

  socket.on("message", (data: RawData) => {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (
      !isRecord(message) ||
      message.type !== "PERMISSION_RESPONSE" ||
      message.sessionId !== sessionId ||
      message.requestId !== requestId ||
      typeof message.payload !== "string"
    ) {
      return;
    }

    if (message.payload === "allow" || message.payload === "y\r") {
      void finish({ permissionDecision: "allow" });
    } else if (message.payload === "deny" || message.payload === "n\r") {
      void finish({
        permissionDecision: "deny",
        permissionDecisionReason: "Denied via CLIa mascot overlay"
      });
    } else {
      void finish();
    }
  });

  socket.on("error", () => {
    if (!registered) {
      void finish();
    }
  });
  socket.on("close", () => {
    void finish();
  });
}

void runHook().catch((error: unknown) => {
  console.error("CLIa hook failed:", error);
  process.exitCode = 0;
});
