#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface ClaudeHookCommand {
  type: "command";
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookCommand[];
}

type JsonObject = Record<string, unknown>;

const thisDirectory = __dirname;

function printUsage(): void {
  console.log(`Usage:
  clia run <command> [...args]
  clia wrap <command> [...args]
  clia test
  clia mock
  clia hook claude
  clia hook install-claude [--global]`);
}

function runNodeScript(scriptName: string, args: string[]): Promise<number> {
  const javascriptPath = path.join(thisDirectory, `${scriptName}.js`);
  const typescriptPath = path.join(thisDirectory, `${scriptName}.ts`);

  return new Promise((resolve, reject) => {
    void access(javascriptPath).then(
      () => launch(process.execPath, [javascriptPath, ...args]),
      () => {
        const tsxPath = path.resolve(
          thisDirectory,
          "../../node_modules/tsx/dist/cli.mjs"
        );
        void access(tsxPath).then(
          () => launch(process.execPath, [tsxPath, typescriptPath, ...args]),
          reject
        );
      }
    );

    function launch(executable: string, childArgs: string[]): void {
      const child = spawn(executable, childArgs, {
        stdio: "inherit",
        windowsHide: false
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          resolve(1);
        } else {
          resolve(code ?? 1);
        }
      });
    }
  });
}

function quoteShellArgument(argument: string): string {
  if (process.platform === "win32") {
    return `"${argument.replace(/"/g, '\\"')}"`;
  }
  return `'${argument.replace(/'/g, "'\\''")}'`;
}

async function resolvePetHookCommand(): Promise<string> {
  const javascriptPath = path.join(thisDirectory, "pet-hook.js");
  try {
    await access(javascriptPath);
    return [process.execPath, javascriptPath]
      .map(quoteShellArgument)
      .join(" ");
  } catch {
    const typescriptPath = path.join(thisDirectory, "pet-hook.ts");
    const tsxPath = path.resolve(
      thisDirectory,
      "../../node_modules/tsx/dist/cli.mjs"
    );
    await Promise.all([access(typescriptPath), access(tsxPath)]);
    return [process.execPath, tsxPath, typescriptPath]
      .map(quoteShellArgument)
      .join(" ");
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function installClaudeHook(global: boolean): Promise<void> {
  const settingsPath = global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.resolve(process.cwd(), ".claude", "settings.json");
  const hookCommand = await resolvePetHookCommand();
  await mkdir(path.dirname(settingsPath), { recursive: true });

  let settings: JsonObject = {};
  try {
    const existing = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isObject(existing)) {
      throw new Error("Claude settings must contain a JSON object.");
    }
    settings = existing;
  } catch (error) {
    if (
      isObject(error) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      settings = {};
    } else {
      throw error;
    }
  }

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isObject(hooksValue)) {
    throw new Error("The existing Claude settings 'hooks' value is not an object.");
  }
  const hooks: JsonObject = isObject(hooksValue) ? hooksValue : {};
  const preToolUseValue = hooks.PreToolUse;
  if (preToolUseValue !== undefined && !Array.isArray(preToolUseValue)) {
    throw new Error("The existing Claude PreToolUse configuration is not an array.");
  }
  const preToolUse: unknown[] = Array.isArray(preToolUseValue)
    ? preToolUseValue.slice()
    : [];

  const alreadyInstalled = preToolUse.some(
    (matcher): matcher is ClaudeHookMatcher =>
      isObject(matcher) &&
      Array.isArray(matcher.hooks) &&
      matcher.hooks.some(
        (hook) =>
          isObject(hook) &&
          hook.type === "command" &&
          hook.command === hookCommand
      )
  );
  if (!alreadyInstalled) {
    preToolUse.push({
      matcher: "",
      hooks: [{ type: "command", command: hookCommand }]
    });
  }
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
  await rename(temporaryPath, settingsPath);

  console.log(`Installed CLIa Claude Code PreToolUse hook in:\n${settingsPath}`);
  console.log(
    "Restart Claude Code to activate the hook. If the mascot is offline, Claude Code uses its normal permission prompt."
  );
}

async function main(args: string[]): Promise<number> {
  const [subcommand, ...subcommandArgs] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return subcommand ? 0 : 1;
  }

  if (subcommand === "run" || subcommand === "wrap") {
    if (subcommandArgs.length === 0) {
      printUsage();
      return 1;
    }
    return runNodeScript("pet-wrap", subcommandArgs);
  }

  if (subcommand === "test" || subcommand === "mock") {
    const mockScript = await resolveScript("mock-agent");
    const mockCommand = process.execPath;
    const mockArgs = [mockScript.executable, ...mockScript.args, "--once"];
    return runNodeScript("pet-wrap", [mockCommand, ...mockArgs]);
  }

  if (subcommand === "hook") {
    const [hookCommand, ...hookArgs] = subcommandArgs;
    if (hookCommand === "claude" && hookArgs.length === 0) {
      return runNodeScript("pet-hook", []);
    }
    if (hookCommand === "install-claude") {
      const invalidArgs = hookArgs.filter((argument) => argument !== "--global");
      if (invalidArgs.length > 0 || hookArgs.filter((arg) => arg === "--global").length > 1) {
        throw new Error("Usage: clia hook install-claude [--global]");
      }
      await installClaudeHook(hookArgs.includes("--global"));
      return 0;
    }
  }

  printUsage();
  return 1;
}

async function resolveScript(
  scriptName: string
): Promise<{ executable: string; args: string[] }> {
  const javascriptPath = path.join(thisDirectory, `${scriptName}.js`);
  try {
    await access(javascriptPath);
    return { executable: javascriptPath, args: [] };
  } catch {
    const tsxPath = path.resolve(
      thisDirectory,
      "../../node_modules/tsx/dist/cli.mjs"
    );
    await access(tsxPath);
    return {
      executable: tsxPath,
      args: [path.join(thisDirectory, `${scriptName}.ts`)]
    };
  }
}

void main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error("clia:", error);
    process.exitCode = 1;
  });
