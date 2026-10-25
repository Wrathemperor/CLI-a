import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { createWebSocketHub } from "../src/main/ws-server";
import type {
  PermissionRequestMessage,
  PetStateSnapshot
} from "../src/shared/protocol";

test(
  "WebSocket hub registers sessions and dispatches permission decisions",
  { timeout: 10000 },
  async (t) => {
    const rendererEvents: Array<{ channel: string; payload: unknown }> = [];
    const hub = createWebSocketHub({
      port: 0,
      getRenderer: () => ({
        send: (channel, payload) =>
          rendererEvents.push({ channel, payload }),
        isDestroyed: () => false
      })
    });
    t.after(async () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
        await once(client, "close");
      }
      await hub.close();
    });

    await once(hub.server, "listening");
    const address = hub.server.address() as AddressInfo;
    assert.ok(address.port > 0);
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");

    const sessionId = "phase3-test-session";
    const requestId = "phase3-test-request";
    client.send(
      JSON.stringify({
        type: "REGISTER",
        sessionId,
        command: "mock-agent",
        pid: process.pid,
        cwd: process.cwd()
      })
    );
    await waitForEvent(rendererEvents, "pet:state-update", (payload) =>
      (payload as PetStateSnapshot).sessions.some(
        (session) => session.sessionId === sessionId
      )
    );
    assert.equal(hub.sessions.get(sessionId)?.command, "mock-agent");

    const permissionRequest: PermissionRequestMessage = {
      type: "PERMISSION_REQUEST",
      sessionId,
      requestId,
      toolName: "Bash",
      summary: "echo phase3",
      rawContext: "Allow Bash command",
      options: [{ label: "Yes", payload: "y\r", style: "approve" }]
    };
    const responsePromise = once(client, "message").then(([raw]) =>
      JSON.parse(raw.toString())
    );
    client.send(JSON.stringify(permissionRequest));

    await waitForEvent(rendererEvents, "pet:queue-update", (payload) =>
      Array.isArray(payload) &&
      payload.some(
        (request) =>
          (request as PermissionRequestMessage).requestId === requestId
      )
    );
    assert.equal(hub.pendingQueue.length, 1);
    assert.equal(
      hub.dispatchDecision(sessionId, requestId, "y\r"),
      true
    );
    assert.deepEqual(await responsePromise, {
      type: "PERMISSION_RESPONSE",
      sessionId,
      requestId,
      payload: "y\r"
    });
    await waitForQueueLength(hub, 0);
    assert.equal(hub.pendingQueue.length, 0);
    await waitForEvent(rendererEvents, "pet:queue-update", (payload) =>
      Array.isArray(payload) && payload.length === 0
    );

    const nextRequestId = "phase3-test-request-next";
    client.send(
      JSON.stringify({
        ...permissionRequest,
        requestId: nextRequestId,
        summary: "echo after approval"
      })
    );
    await waitForEvent(rendererEvents, "pet:queue-update", (payload) =>
      Array.isArray(payload) &&
      payload.some(
        (request) =>
          (request as PermissionRequestMessage).requestId === nextRequestId
      )
    );
    assert.equal(hub.sessions.has(sessionId), true);
    assert.equal(hub.pendingQueue.length, 1);
    assert.equal(hub.sessions.get(sessionId)?.state, "WAITING_PERMISSION");
    const nextResponsePromise = once(client, "message").then(([raw]) =>
      JSON.parse(raw.toString())
    );
    assert.equal(
      hub.dispatchDecision(sessionId, nextRequestId, "2"),
      true
    );
    assert.deepEqual(await nextResponsePromise, {
      type: "PERMISSION_RESPONSE",
      sessionId,
      requestId: nextRequestId,
      payload: "2"
    });
    await waitForQueueLength(hub, 0);
    assert.equal(hub.pendingQueue.length, 0);

    client.send(
      JSON.stringify({
        type: "UNREGISTER",
        sessionId,
        exitCode: 0
      })
    );
    await waitForEvent(rendererEvents, "pet:state-update", (payload) =>
      !(payload as PetStateSnapshot).sessions.some(
        (session) => session.sessionId === sessionId
      )
    );
    assert.equal(hub.sessions.has(sessionId), false);
  }
);

function waitForQueueLength(
  hub: ReturnType<typeof createWebSocketHub>,
  length: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for queue length ${length}`));
    }, 5000);
    const interval = setInterval(() => {
      if (hub.pendingQueue.length === length) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

function waitForEvent(
  events: Array<{ channel: string; payload: unknown }>,
  channel: string,
  predicate: (payload: unknown) => boolean
): Promise<unknown> {
  const existing = events.find(
    (event) => event.channel === channel && predicate(event.payload)
  );
  if (existing) {
    return Promise.resolve(existing.payload);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${channel}`)),
      5000
    );
    const check = setInterval(() => {
      const event = events.find(
        (candidate) =>
          candidate.channel === channel && predicate(candidate.payload)
      );
      if (event) {
        clearTimeout(timeout);
        clearInterval(check);
        resolve(event.payload);
      }
    }, 10);
  });
}
