import { WebSocket, WebSocketServer, type RawData } from "ws";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type {
  PermissionRequestMessage,
  PermissionResponseMessage,
  PetStateSnapshot,
  RegisterMessage,
  SessionInfo,
  StateUpdateMessage,
  UnregisterMessage
} from "../shared/protocol";

export const PET_WS_HOST = "127.0.0.1";
export const PET_WS_PORT = 49152;
const DEBUG_LOG_PATH = path.join(process.cwd(), "clia-debug.log");

function writeDebugLog(message: string): void {
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("[clia-hub] Failed to write debug log:", error);
  }
}

export interface RendererEventTarget {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface WebSocketHubOptions {
  getRenderer: () => RendererEventTarget | undefined;
  host?: string;
  port?: number;
}

export interface WebSocketHub {
  readonly server: WebSocketServer;
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  readonly pendingQueue: PermissionRequestMessage[];
  dispatchDecision(
    sessionId: string,
    requestId: string,
    payload: string
  ): boolean;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRegisterMessage(value: unknown): value is RegisterMessage {
  return (
    isRecord(value) &&
    value.type === "REGISTER" &&
    typeof value.sessionId === "string" &&
    typeof value.command === "string" &&
    typeof value.pid === "number" &&
    typeof value.cwd === "string"
  );
}

function isStateUpdateMessage(value: unknown): value is StateUpdateMessage {
  return (
    isRecord(value) &&
    value.type === "STATE_UPDATE" &&
    typeof value.sessionId === "string" &&
    (value.state === "IDLE" ||
      value.state === "WORKING" ||
      value.state === "WAITING_PERMISSION" ||
      value.state === "ERROR")
  );
}

function isPermissionRequestMessage(
  value: unknown
): value is PermissionRequestMessage {
  if (
    !isRecord(value) ||
    value.type !== "PERMISSION_REQUEST" ||
    typeof value.sessionId !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.rawContext !== "string" ||
    !Array.isArray(value.options)
  ) {
    return false;
  }

  return value.options.every(
    (option) =>
      isRecord(option) &&
      typeof option.label === "string" &&
      typeof option.payload === "string" &&
      (option.style === "approve" ||
        option.style === "deny" ||
        option.style === "neutral")
  );
}

function isUnregisterMessage(value: unknown): value is UnregisterMessage {
  return (
    isRecord(value) &&
    value.type === "UNREGISTER" &&
    typeof value.sessionId === "string" &&
    typeof value.exitCode === "number"
  );
}

export function createWebSocketHub(
  options: WebSocketHubOptions
): WebSocketHub {
  const server = new WebSocketServer({
    host: options.host ?? PET_WS_HOST,
    port: options.port ?? PET_WS_PORT
  });
  const activeSessions = new Map<string, SessionInfo>();
  const sessionSockets = new Map<string, WebSocket>();
  const pendingQueue: PermissionRequestMessage[] = [];
  const decisionsInFlight = new Set<string>();

  const broadcastState = (): void => {
    const renderer = options.getRenderer();
    if (!renderer || renderer.isDestroyed()) {
      return;
    }

    const snapshot: PetStateSnapshot = {
      sessions: Array.from(activeSessions.values(), (session) => ({
        sessionId: session.sessionId,
        command: session.command,
        pid: session.pid,
        cwd: session.cwd,
        state: session.state
      }))
    };
    renderer.send("pet:state-update", snapshot);
  };

  const broadcastQueue = (): void => {
    const renderer = options.getRenderer();
    if (!renderer || renderer.isDestroyed()) {
      writeDebugLog(
        `Queue broadcast skipped: renderer=${renderer ? "destroyed" : "unavailable"}; queueLength=${pendingQueue.length}`
      );
      return;
    }
    writeDebugLog(
      `Broadcasting queue update: queueLength=${pendingQueue.length}; requestIds=${pendingQueue
        .map((request) => request.requestId)
        .join(",")}`
    );
    renderer.send("pet:queue-update", pendingQueue.slice());
  };

  const removeSession = (sessionId: string, socket?: WebSocket): void => {
    const session = activeSessions.get(sessionId);
    const sessionSocket = sessionSockets.get(sessionId);
    if (!session || (socket && sessionSocket !== socket)) {
      return;
    }

    activeSessions.delete(sessionId);
    sessionSockets.delete(sessionId);
    for (let index = pendingQueue.length - 1; index >= 0; index -= 1) {
      if (pendingQueue[index]?.sessionId === sessionId) {
        pendingQueue.splice(index, 1);
      }
    }
    broadcastState();
    broadcastQueue();
  };

  const handleMessage = (socket: WebSocket, rawMessage: RawData) => {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      console.error("Ignoring invalid CLI WebSocket message:", error);
      return;
    }

    if (isRegisterMessage(message)) {
      const previousSocket = sessionSockets.get(message.sessionId);
      if (previousSocket && previousSocket !== socket) {
        removeSession(message.sessionId, previousSocket);
      }
      activeSessions.set(message.sessionId, {
        ...message,
        state: "IDLE"
      });
      sessionSockets.set(message.sessionId, socket);
      broadcastState();
      return;
    }

    if (isStateUpdateMessage(message)) {
      const session = activeSessions.get(message.sessionId);
      if (!session || sessionSockets.get(message.sessionId) !== socket) {
        return;
      }
      session.state = message.state;
      broadcastState();
      return;
    }

    if (isPermissionRequestMessage(message)) {
      const session = activeSessions.get(message.sessionId);
      if (!session || sessionSockets.get(message.sessionId) !== socket) {
        writeDebugLog(
          `Rejected PERMISSION_REQUEST: sessionId=${message.sessionId}; requestId=${message.requestId}; registered=${Boolean(session)}; socketMatches=${sessionSockets.get(message.sessionId) === socket}`
        );
        return;
      }
      session.state = "WAITING_PERMISSION";
      const duplicate = pendingQueue.some(
        (request) => request.requestId === message.requestId
      );
      if (!duplicate) {
        pendingQueue.push(message);
      }
      writeDebugLog(
        `Queued PERMISSION_REQUEST: sessionId=${message.sessionId}; requestId=${message.requestId}; duplicate=${duplicate}; queueLength=${pendingQueue.length}`
      );
      broadcastState();
      broadcastQueue();
      return;
    }

    if (isUnregisterMessage(message)) {
      removeSession(message.sessionId, socket);
    }
  };

  server.on("connection", (socket) => {
    socket.on("message", (message) => handleMessage(socket, message));
    socket.on("close", () => {
      for (const [sessionId, sessionSocket] of sessionSockets) {
        if (sessionSocket === socket) {
          removeSession(sessionId, socket);
        }
      }
    });
  });

  return {
    server,
    get sessions() {
      return new Map(activeSessions);
    },
    pendingQueue,
    dispatchDecision(sessionId, requestId, payload) {
      const session = activeSessions.get(sessionId);
      const queueIndex = pendingQueue.findIndex(
        (request) =>
          request.sessionId === sessionId && request.requestId === requestId
      );
      const decisionKey = `${sessionId}:${requestId}`;
      if (
        !session ||
        queueIndex === -1 ||
        sessionSockets.get(sessionId)?.readyState !== WebSocket.OPEN ||
        decisionsInFlight.has(decisionKey)
      ) {
        writeDebugLog(
          `Rejected PERMISSION_RESPONSE dispatch: sessionId=${sessionId}; requestId=${requestId}; session=${Boolean(session)}; queueIndex=${queueIndex}; socketReadyState=${sessionSockets.get(sessionId)?.readyState ?? "missing"}; inFlight=${decisionsInFlight.has(decisionKey)}`
        );
        return false;
      }

      const socket = sessionSockets.get(sessionId);
      if (!socket) {
        return false;
      }
      const response: PermissionResponseMessage = {
        type: "PERMISSION_RESPONSE",
        sessionId,
        requestId,
        payload
      };
      decisionsInFlight.add(decisionKey);
      writeDebugLog(
        `Sending PERMISSION_RESPONSE: sessionId=${sessionId}; requestId=${requestId}; payload=${JSON.stringify(payload)}`
      );
      try {
        socket.send(
          JSON.stringify(response),
          (error?: Error) => {
            decisionsInFlight.delete(decisionKey);
            if (error) {
              writeDebugLog(
                `PERMISSION_RESPONSE send failed: sessionId=${sessionId}; requestId=${requestId}; error=${JSON.stringify(error.message)}`
              );
              console.error("Failed to send permission response:", error);
              return;
            }
            writeDebugLog(
              `PERMISSION_RESPONSE send confirmed: sessionId=${sessionId}; requestId=${requestId}`
            );

            const currentQueueIndex = pendingQueue.findIndex(
              (request) =>
                request.sessionId === sessionId &&
                request.requestId === requestId
            );
            if (currentQueueIndex === -1) {
              return;
            }
            pendingQueue.splice(currentQueueIndex, 1);
            const currentSession = activeSessions.get(sessionId);
            if (currentSession) {
              currentSession.state = pendingQueue.some(
                (request) => request.sessionId === sessionId
              )
                ? "WAITING_PERMISSION"
                : "WORKING";
            }
            broadcastQueue();
            broadcastState();
          }
        );
      } catch (error) {
        decisionsInFlight.delete(decisionKey);
        writeDebugLog(
          `PERMISSION_RESPONSE send threw: sessionId=${sessionId}; requestId=${requestId}; error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
        );
        console.error("Failed to send permission response:", error);
        return false;
      }

      return true;
    },
    close() {
      return new Promise((resolve, reject) => {
        for (const socket of server.clients) {
          socket.close();
        }
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  };
}
