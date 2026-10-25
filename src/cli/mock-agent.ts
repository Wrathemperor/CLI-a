import { createInterface } from "node:readline";

type MockProfile = "agy" | "claude" | "codex";

interface MockPrompt {
  profile: MockProfile;
  summary: string;
  text: string;
  choices: string[];
}

const colors = {
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m"
};

const validProfiles: MockProfile[] = ["agy", "claude", "codex"];
const profileArgument = process.argv.indexOf("--profile");
const selectedProfile =
  profileArgument >= 0
    ? process.argv[profileArgument + 1]
    : undefined;
if (
  selectedProfile !== undefined &&
  !validProfiles.includes(selectedProfile as MockProfile)
) {
  throw new Error(`Unknown mock profile: ${selectedProfile}`);
}

const exitAfterResponse = process.argv.includes("--once");
const delayArgument = process.argv.indexOf("--delay-ms");
const delayMs = Number(
  delayArgument >= 0
    ? process.argv[delayArgument + 1]
    : process.env.CLIA_MOCK_DELAY_MS ?? 4000
);
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error("--delay-ms must be a non-negative number.");
}

const input = process.stdin.isTTY
  ? undefined
  : createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

const promptSets: Record<MockProfile, MockPrompt[]> = {
  agy: [
    {
      profile: "agy",
      summary: "Get-ChildItem -Path src, test -Recurse",
      text:
        "Requesting permission for:\nGet-ChildItem -Path src, test -Recurse\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n↑/↓ Navigate · tab Amend · esc to cancel",
      choices: ["1", "2", "3", "4", "\u001b"]
    },
    {
      profile: "agy",
      summary: "Get-ChildItem -Force",
      text:
        "Requesting permission for:\nGet-ChildItem -Force\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel\n↑/↓ Navigate · tab Amend · esc to cancel",
      choices: ["1", "2", "3", "4", "\u001b"]
    }
  ],
  claude: [
    {
      profile: "claude",
      summary: "npm test",
      text:
        "Do you want to proceed?\n1. Yes\n2. Yes, and don't ask again for this session\n3. No",
      choices: ["1", "2", "3"]
    },
    {
      profile: "claude",
      summary: "src/example.ts",
      text:
        "Do you want to make this edit to src/example.ts?\n1. Yes\n2. Yes, and don't ask again for this session\n3. No",
      choices: ["1", "2", "3"]
    }
  ],
  codex: [
    {
      profile: "codex",
      summary:
        'git add .; git diff --cached --stat; git commit -m "chore: initialize CLIa repository"; git status --short; git log -1 --oneline',
      text:
        "Would you like to run the following command?\n\nEnvironment: local\n\nReason: Do you want me to stage and create the requested initial Git commit for this project?\n\n$ git add .; git diff --cached --stat; git commit -m \"chore: initialize CLIa repository\"; git status --short; git log -1 --oneline\n\n› 1. Yes, proceed (y)\n2. Yes, and don't ask again for commands that start with `git add .` (p)\n3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel",
      choices: ["\r", "p", "\u001b"]
    },
    {
      profile: "codex",
      summary: "git status --short",
      text:
        "Would you like to run the following command?\n\nEnvironment: local\n\nReason: Check the current working tree state.\n\n$ git status --short\n\n› 1. Yes, proceed (y)\n2. Yes, and don't ask again for commands that start with `git` (p)\n3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel",
      choices: ["\r", "p", "\u001b"]
    }
  ]
};

function writeLog(message: string, color: string): void {
  process.stdout.write(`${color}${message}${colors.reset}\n`);
}

function getPromptSequence(): MockPrompt[] {
  const profiles = selectedProfile
    ? [selectedProfile as MockProfile]
    : validProfiles;
  const sequence = profiles.flatMap((profile) => promptSets[profile]);
  return exitAfterResponse ? sequence.slice(0, 1) : sequence;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForLineResponse(prompt: MockPrompt): Promise<string | null> {
  if (!input) {
    throw new Error("Line-based input is unavailable.");
  }
  return new Promise((resolve) => {
    input.question(`${colors.yellow}${prompt.text}${colors.reset}\n`, (answer) => {
      const normalized = answer.trim().toLowerCase();
      resolve(prompt.choices.includes(normalized) ? normalized : null);
    });
  });
}

function waitForRawResponse(prompt: MockPrompt): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Raw terminal input is unavailable.");
  }

  return new Promise((resolve, reject) => {
    let bufferedKeys = "";
    const restoreInput = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onEnd = (): void => {
      restoreInput();
      reject(new Error("Standard input closed while waiting for a response."));
    };
    const onData = (data: Buffer): void => {
      const bytes = Buffer.from(data);
      const received = bytes.toString("utf8");
      console.error(
        `[mock-agent] received keys=${JSON.stringify(received)} bytes=${bytes.toString("hex")}`
      );
      bufferedKeys += received.toLowerCase();
      const selection = prompt.choices.find((choice) =>
        bufferedKeys.includes(choice)
      );
      if (selection) {
        restoreInput();
        resolve(selection);
        return;
      }
      if (bufferedKeys.includes("\u0003")) {
        restoreInput();
        process.exitCode = 130;
        resolve(null);
        return;
      }
      bufferedKeys = bufferedKeys.slice(-8);
    };

    process.stdout.write(`${colors.yellow}${prompt.text}${colors.reset}\n`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

async function run(): Promise<void> {
  const sequence = getPromptSequence();
  for (let index = 0; index < sequence.length; index += 1) {
    const prompt = sequence[index];
    if (!prompt) {
      continue;
    }

    await wait(delayMs);
    writeLog(`[agent:${prompt.profile}] Thinking...`, colors.cyan);
    writeLog(`[agent:${prompt.profile}] Preparing ${prompt.summary}`, colors.green);
    const response = process.stdin.isTTY
      ? await waitForRawResponse(prompt)
      : await waitForLineResponse(prompt);
    if (response === null) {
      if (process.exitCode === 130) {
        return;
      }
      throw new Error(`Invalid response for ${prompt.profile} prompt.`);
    }

    writeLog(
      `[agent:${prompt.profile}] Received ${JSON.stringify(response)} for ${JSON.stringify(prompt.summary)}.`,
      colors.cyan
    );
  }
}

run()
  .catch((error: unknown) => {
    console.error("[agent] Mock agent failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    input?.close();
  });
