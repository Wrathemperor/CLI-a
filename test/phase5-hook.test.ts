import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { createWebSocketHub } from "../src/main/ws-server";

const projectRoot = process.cwd();
const tsxCli = path.resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const hookPath = path.resolve(projectRoot, "src/cli/pet-hook.ts");
const hookPayload = JSON.stringify({
  session_id: "phase5-hook-session",
  cwd: "D:/Projects/CLIa",
  tool_name: "Bash",
  tool_input: { command: "npm publish" }
});

async function runDecisionFlow(
  payload: "allow" | "deny",
  expectedExitCode: number,
  expectedDecision: "allow" | "deny"
): Promise<void> {
  const hub = createWebSocketHub({ getRenderer: () => undefined, port: 0 });
  await once(hub.server, "listening");
  const address = hub.server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [tsxCli, hookPath], {
    cwd: projectRoot,
    env: { ...process.env, CLIA_WS_PORT: String(address.port) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const childExit = once(child, "exit") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  const timeout = setTimeout(() => {
    child.kill();
  }, 7000);

  try {
    child.stdin.end(hookPayload);
    await waitForPendingRequest(hub);
    const request = hub.pendingQueue[0];
    assert.ok(request);
    assert.equal(request.sessionId, "phase5-hook-session");
    assert.equal(request.toolName, "Bash");
    assert.equal(request.summary, "npm publish");
    assert.equal(
      hub.dispatchDecision(request.sessionId, request.requestId, payload),
      true
    );

    const [exitCode] = await childExit;
    assert.equal(exitCode, expectedExitCode, stderr);
    const output = JSON.parse(stdout.trim()) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason?: string;
      };
    };
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, expectedDecision);
    if (expectedDecision === "deny") {
      assert.equal(
        output.hookSpecificOutput.permissionDecisionReason,
        "Denied via CLIa mascot overlay"
      );
    }
    assert.equal(hub.sessions.has("phase5-hook-session"), false);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await childExit;
    }
    await hub.close();
  }
}

test("pet-hook allows a tool after the mascot approval", async () => {
  await runDecisionFlow("allow", 0, "allow");
});

test("pet-hook denies a tool after the mascot denial", async () => {
  await runDecisionFlow("deny", 2, "deny");
});

test(
  "pet-hook silently falls back when the mascot server is offline",
  { timeout: 5000 },
  async () => {
    const port = await getUnusedPort();
    const startedAt = Date.now();
    const child = spawn(process.execPath, [tsxCli, hookPath], {
      cwd: projectRoot,
      env: { ...process.env, CLIA_WS_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(hookPayload);
    const [exitCode] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null
    ];
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout, "");
    assert.ok(Date.now() - startedAt < 1500);
  }
);

function waitForPendingRequest(
  hub: ReturnType<typeof createWebSocketHub>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Timed out waiting for hook permission request."));
    }, 5000);
    const interval = setInterval(() => {
      if (hub.pendingQueue.length > 0) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

async function getUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not allocate an unused TCP port."));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
