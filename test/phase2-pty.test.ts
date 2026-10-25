import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  CliStreamParser,
  type DetectedPermissionRequest
} from "../src/cli/parser";
import type {
  CliToMascotMessage,
  PermissionRequestMessage
} from "../src/shared/protocol";

const projectRoot = process.cwd();
const tsxCli = path.resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const wrapperPath = path.resolve(projectRoot, "src/cli/pet-wrap.ts");
const mockAgentPath = path.resolve(projectRoot, "src/cli/mock-agent.ts");

async function detectPrompt(
  command: string,
  output: string
): Promise<DetectedPermissionRequest | undefined> {
  return new Promise((resolve) => {
    const parser = new CliStreamParser({
      command,
      debounceMs: 5,
      onPermissionRequest: resolve,
      onIdle: () => resolve(undefined)
    });
    parser.push(output);
  });
}

test("parser recognizes generic, Aider, and numbered permission prompts", async () => {
  const generic = await detectPrompt("some-cli", "Continue? [Y/n]");
  assert.ok(generic?.options.some((option) => option.payload === "y\r"));
  assert.ok(!generic?.options.some((option) => option.payload === "a\r"));

  const aider = await detectPrompt(
    "aider",
    "Apply these changes? (Y)es/(N)o, (D)on't ask again"
  );
  assert.ok(aider?.options.some((option) => option.payload === "d\r"));

  const numbered = await detectPrompt(
    "claude",
    "Do you want to proceed?\n1. Yes\n2. Yes, and don't ask again\n3. No"
  );
  assert.deepEqual(
    numbered?.options.map((option) => option.payload),
    ["1", "2", "3"]
  );
});

test("parser detects Codex, Aider, and Claude Code prompt profiles", async () => {
  const claudeEdit = await detectPrompt(
    "claude",
    "Do you want to make this edit to src/app.ts?\n1. Yes\n2. Yes, and don't ask again for this session\n3. No"
  );
  assert.equal(claudeEdit?.options.length, 3);
  assert.equal(claudeEdit?.options[2]?.style, "deny");

  const codex = await detectPrompt(
    "codex",
    [
      "Would you like to run the following command?",
      "",
      "Environment: local",
      "",
      "Reason: Should I run this?",
      "",
      "$ git add .; git diff --cached --stat;",
      'git commit -m "chore: initialize CLIa repository"; git status --short;',
      "git log -1 --oneline",
      "",
      "› 1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `git add .` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "",
      "Press enter to confirm or esc to cancel"
    ].join("\n")
  );
  assert.equal(
    codex?.summary,
    'git add .; git diff --cached --stat; git commit -m "chore: initialize CLIa repository"; git status --short; git log -1 --oneline'
  );
  assert.deepEqual(
    codex?.options.map((option) => [option.label, option.payload, option.style]),
    [
      ["Approve [1 / y]", "\r", "approve"],
      ["Always Allow [2 / p]", "p", "neutral"],
      ["Cancel [3 / Esc]", "\u001b", "deny"]
    ]
  );

  const aider = await detectPrompt(
    "aider",
    "Run command? git status --short (y)es/(n)o/(a)lways"
  );
  assert.deepEqual(
    aider?.options.map((option) => option.payload),
    ["y\r", "n\r", "a\r"]
  );
});

test("parser recognizes Antigravity CLI multiline permission prompts", async () => {
  const parserOutput: DetectedPermissionRequest[] = [];
  let resolveRequest: ((request: DetectedPermissionRequest) => void) | undefined;
  const detected = new Promise<DetectedPermissionRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const parser = new CliStreamParser({
    command: "agy",
    debounceMs: 5,
    onPermissionRequest: (request) => {
      parserOutput.push(request);
      resolveRequest?.(request);
    },
    onIdle: () => undefined
  });
  parser.push(
    "Requesting permission for:\r\nGet-ChildItem -Path .\r\nRun this command?\r\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parserOutput.length, 0);
  parser.push(
    "1. Approve\r\n2. Always (Session)\r\n3. Always (Persist)\r\n"
  );
  const request = await detected;

  assert.equal(request?.toolName, "Shell Command");
  assert.equal(request?.summary, "Get-ChildItem -Path .");
  assert.ok(request?.rawContext.includes("Always (Persist)"));
  assert.deepEqual(
    request.options.map((option) => [option.label, option.payload]),
    [
      ["Approve [1]", "1\r"],
      ["Always (Session) [2]", "2\r"],
      ["Always (Persist) [3]", "3\r"],
      ["Cancel [4 / Esc]", "\u001b"]
    ]
  );
  assert.deepEqual(
    parserOutput[0]?.options.map((option) => option.payload),
    ["1\r", "2\r", "3\r", "\u001b"]
  );
  assert.equal(request.options[0]?.style, "approve");
  assert.equal(request.options[1]?.style, "neutral");
  assert.equal(request.options[2]?.style, "neutral");
  assert.equal(parser.hasPendingPermission, true);

  const secondRequest = new Promise<void>((resolve) => {
    const onPrompt = (): void => {
      parser.off("prompt", onPrompt);
      resolve();
    };
    parser.on("prompt", onPrompt);
  });
  parser.reset();
  parser.push(
    "Requesting permission for:\r\nGet-ChildItem -Path src\r\nRun this command?\r\n1. Approve\r\n2. Always (Session)\r\n3. Always (Persist)\r\n"
  );
  await secondRequest;
  assert.equal(parserOutput.length, 2);
  assert.equal(parserOutput[1]?.summary, "Get-ChildItem -Path src");
});

test("Antigravity parser accepts variable option wording and cursor movement", async () => {
  const request = await detectPrompt(
    "agy",
    "Requesting permission for:\u001b[1BGet-ChildItem -Path .\u001b[2;1HRun this command?\u001b[1B1. Yes, and tell Antigravity CLI what to do next"
  );

  assert.equal(request?.summary, "Get-ChildItem -Path .");
  assert.equal(request?.options.length, 4);
  assert.equal(request?.options[0]?.payload, "1\r");
  assert.equal(request?.options[3]?.payload, "\u001b");
});

test("Antigravity parser restores words separated by ConPTY cursor movement", async () => {
  const request = await detectPrompt(
    "agy",
    "Requesting\u001b[1Cpermission\u001b[Cfor:\nGet-ChildItem -Path .\nRun\u001b[1Cthis\u001b[1Ccommand?\n1. Yes, run command"
  );

  assert.equal(request?.toolName, "Shell Command");
  assert.equal(request?.summary, "Get-ChildItem -Path .");
});

test("parser releases pending state when a fresh Antigravity prompt appears", async () => {
  const requests: DetectedPermissionRequest[] = [];
  const parser = new CliStreamParser({
    command: "agy",
    debounceMs: 5,
    onPermissionRequest: (request) => requests.push(request),
    onIdle: () => undefined
  });
  parser.push(
    "Requesting permission for:\nfirst-command\nRun this command?\n1. Yes, run command"
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  parser.push(
    "\nRequesting permission for:\nsecond-command\nRun this command?\n1. Yes, and tell Antigravity CLI..."
  );
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.summary, "second-command");
});

test(
  "pet-wrap forwards a permission response to the wrapped mock agent",
  { timeout: 30000 },
  async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      server.close();
      await once(server, "close");
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const permissionRequestPromise = new Promise<PermissionRequestMessage>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for PERMISSION_REQUEST")),
          12000
        );

        server.once("connection", (client) => {
          client.on("message", (rawMessage) => {
            const message = JSON.parse(
              rawMessage.toString()
            ) as CliToMascotMessage;
            if (message.type !== "PERMISSION_REQUEST") {
              return;
            }

            clearTimeout(timeout);
            resolve(message);
            client.send(
              JSON.stringify({
                type: "PERMISSION_RESPONSE",
                sessionId: message.sessionId,
                requestId: message.requestId,
                payload: "y"
              })
            );
          });
        });
      }
    );

    const child = spawn(
      process.execPath,
      [
        tsxCli,
        wrapperPath,
        process.execPath,
        tsxCli,
        mockAgentPath,
        "--profile",
        "codex",
        "--delay-ms",
        "1",
        "--once"
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, CLIA_WS_PORT: String(address.port) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const childExitPromise = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await childExitPromise;
      }
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

    const request = await permissionRequestPromise;
    assert.equal(request.type, "PERMISSION_REQUEST");
    assert.match(request.summary, /^git add \.; git diff --cached --stat;/);
    assert.ok(request.rawContext.includes("Press enter to confirm"));
    assert.ok(request.options.some((option) => option.payload === "\r"));

    const [exitCode] = await childExitPromise;
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Received "\\r" for "git add/);
    assert.match(stderr, /\[clia-wrap\] Writing payload to PTY: "\\r"/);
  }
);

test(
  "pet-wrap and mock-agent handle two Antigravity TUI decisions in sequence",
  { timeout: 30000 },
  async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      server.close();
      await once(server, "close");
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const requests: PermissionRequestMessage[] = [];
    const allRequestsPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for two Antigravity prompts")),
        15000
      );
      server.on("connection", (client) => {
        client.on("message", (rawMessage) => {
          const message = JSON.parse(
            rawMessage.toString()
          ) as CliToMascotMessage;
          if (message.type !== "PERMISSION_REQUEST") {
            return;
          }
          requests.push(message);
          client.send(
            JSON.stringify({
              type: "PERMISSION_RESPONSE",
              sessionId: message.sessionId,
              requestId: message.requestId,
              payload: "1\r"
            })
          );
          if (requests.length === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    });

    const child = spawn(
      process.execPath,
      [
        tsxCli,
        wrapperPath,
        process.execPath,
        tsxCli,
        mockAgentPath,
        "--profile",
        "agy",
        "--delay-ms",
        "1"
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, CLIA_WS_PORT: String(address.port) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const childExitPromise = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await childExitPromise;
      }
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

    await allRequestsPromise;
    const [exitCode] = await childExitPromise;
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(
      requests.map((request) => request.summary),
      ["Get-ChildItem -Path src, test -Recurse", "Get-ChildItem -Force"]
    );
    assert.match(stdout, /Received "1" for "Get-ChildItem -Path src, test -Recurse"/);
    assert.match(stdout, /Received "1" for "Get-ChildItem -Force"/);
    assert.match(stderr, /Confirming TUI selection with Enter/);
  }
);

test(
  "pet-wrap and mock-agent handle Codex enter and p-key TUI decisions",
  { timeout: 30000 },
  async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      server.close();
      await once(server, "close");
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const requests: PermissionRequestMessage[] = [];
    const allRequestsPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for two Codex prompts")),
        15000
      );
      server.on("connection", (client) => {
        client.on("message", (rawMessage) => {
          const message = JSON.parse(
            rawMessage.toString()
          ) as CliToMascotMessage;
          if (message.type !== "PERMISSION_REQUEST") {
            return;
          }
          requests.push(message);
          client.send(
            JSON.stringify({
              type: "PERMISSION_RESPONSE",
              sessionId: message.sessionId,
              requestId: message.requestId,
              payload: requests.length === 1 ? "\r" : "p"
            })
          );
          if (requests.length === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    });

    const child = spawn(
      process.execPath,
      [
        tsxCli,
        wrapperPath,
        process.execPath,
        tsxCli,
        mockAgentPath,
        "--profile",
        "codex",
        "--delay-ms",
        "100"
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, CLIA_WS_PORT: String(address.port) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const childExitPromise = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await childExitPromise;
      }
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

    await allRequestsPromise;
    const [exitCode] = await childExitPromise;
    assert.equal(exitCode, 0, stderr);
    assert.equal(requests.length, 2);
    assert.match(
      requests[0]?.summary ?? "",
      /^git add \.; git diff --cached --stat;/
    );
    assert.equal(requests[1]?.summary, "git status --short");
    assert.match(stdout, /Received "\\r" for "git add/);
    assert.match(stdout, /Received "p" for "git status --short"/);
    assert.match(stderr, /Confirming TUI selection with Enter/);
  }
);
