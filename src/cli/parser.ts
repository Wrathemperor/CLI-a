import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import path from "node:path";
import stripAnsi from "strip-ansi";
import {
  DEFAULT_PROMPT_PROFILES,
  type PermissionOption,
  type PromptProfile
} from "../shared/protocol";

export interface DetectedPermissionRequest {
  requestId: string;
  toolName: string;
  summary: string;
  rawContext: string;
  options: PermissionOption[];
}

export interface StreamParserOptions {
  command: string;
  onPermissionRequest: (request: DetectedPermissionRequest) => void;
  onIdle: () => void;
  debounceMs?: number;
  bufferLength?: number;
  profiles?: PromptProfile[];
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_BUFFER_LENGTH = 1000;
const DEBUG_LOG_PATH = path.join(process.cwd(), "clia-debug.log");

function writeDebugLog(message: string): void {
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("[clia] Failed to write debug log:", error);
  }
}

export class CliStreamParser extends EventEmitter {
  private buffer = "";
  private postPromptBuffer = "";
  private idleTimer: NodeJS.Timeout | undefined;
  private permissionPending = false;
  private readonly profile: PromptProfile | undefined;
  private readonly genericProfile: PromptProfile | undefined;
  private readonly debounceMs: number;
  private readonly bufferLength: number;

  constructor(private readonly options: StreamParserOptions) {
    super();
    const profiles = options.profiles ?? DEFAULT_PROMPT_PROFILES;
    this.profile = profiles.find(
      (profile) =>
        profile.id !== "generic" && profile.commandPattern.test(options.command)
    );
    this.genericProfile = profiles.find((profile) => profile.id === "generic");
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.bufferLength = options.bufferLength ?? DEFAULT_BUFFER_LENGTH;
  }

  get hasPendingPermission(): boolean {
    return this.permissionPending;
  }

  push(data: string): void {
    const normalizedData = data
      .replace(/\u001b\[\d*C/g, " ")
      .replace(/\u001b\[\d*G/g, " ")
      .replace(/\u001b\[\d*[BHEf]/g, "\n")
      .replace(/\u001b\[\d*;\d*[Hf]/g, "\n");
    const cleanData = stripAnsi(normalizedData).replace(/\u0000/g, "");
    let bufferData = cleanData;
    if (this.permissionPending) {
      this.postPromptBuffer = (
        this.postPromptBuffer + cleanData
      ).slice(-this.bufferLength);
      const freshPermissionBlock =
        /Requesting permission for:/i.test(this.postPromptBuffer);
      const substantialOutput =
        this.postPromptBuffer.trim().length >= 80 &&
        !/Run this command\?/i.test(this.postPromptBuffer);
      if (freshPermissionBlock || substantialOutput) {
        this.permissionPending = false;
        bufferData = this.postPromptBuffer;
        this.buffer = "";
        this.postPromptBuffer = "";
      }
    }
    this.buffer = (this.buffer + bufferData).slice(-this.bufferLength);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      writeDebugLog(
        `Parser debounce: permissionPending=${this.permissionPending}; strippedBuffer=${JSON.stringify(
          this.buffer.slice(-400)
        )}`
      );
      this.evaluateBuffer();
    }, this.debounceMs);
  }

  reset(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.buffer = "";
    this.postPromptBuffer = "";
    this.permissionPending = false;
  }

  private evaluateBuffer(): void {
    if (this.permissionPending) {
      return;
    }

    const lines = this.buffer
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const trailingLines = lines.slice(-5);
    const trailingText = trailingLines.join("\n");
    const profiles = this.profile
      ? [this.profile, this.genericProfile].filter(
          (profile): profile is PromptProfile => profile !== undefined
        )
      : [
          ...(this.options.profiles ?? DEFAULT_PROMPT_PROFILES).filter(
            (profile) => profile.id !== "generic"
          ),
          ...(this.genericProfile ? [this.genericProfile] : [])
        ];

    for (const profile of profiles) {
      const profileText =
        profile.id === "antigravity" || profile.id === "codex"
          ? this.buffer
          : trailingText;
      const rule = profile.rules.find((candidate) =>
        candidate.pattern.test(profileText)
      );
      if (!rule) {
        continue;
      }

      this.permissionPending = true;
      this.postPromptBuffer = "";
      const request: DetectedPermissionRequest = {
        requestId: randomUUID(),
        toolName: this.extractToolName(lines),
        summary: this.extractSummary(lines),
        rawContext: trailingLines.slice(-5).join("\n"),
        options: rule.options.map((option) => ({ ...option }))
      };
      writeDebugLog(
        `Prompt matched: profile=${profile.id}; summary=${JSON.stringify(request.summary)}`
      );
      this.emit("prompt", request);
      this.options.onPermissionRequest(request);
      return;
    }

    this.options.onIdle();
  }

  private extractToolName(lines: string[]): string {
    const context = lines.join("\n");
    if (
      /\bRequesting\s*permission\s*for:[\s\S]*?\bRun\s*this\s*command\?/i.test(
        context
      )
    ) {
      return "Shell Command";
    }
    const toolMatch = context.match(
      /(?:allow|run|execute)\s+([A-Za-z][\w -]*?)\s+command\b/i
    );
    if (toolMatch?.[1]) {
      return toolMatch[1].trim();
    }
    if (/\b(?:edit|write|modify)\s+(?:the\s+)?file\b/i.test(context)) {
      return "File Edit";
    }
    return "CLI";
  }

  private extractSummary(lines: string[]): string {
    const context = lines.join("\n");
    const codexHeaderIndex = lines.findIndex((line) =>
      /Would\s*you\s*like\s*to\s*run\s*the\s*following\s*command\?/i.test(line)
    );
    if (codexHeaderIndex >= 0) {
      const commandIndex = lines.findIndex(
        (line, index) =>
          index > codexHeaderIndex && /^\$\s*/.test(line)
      );
      const menuIndex = lines.findIndex(
        (line, index) =>
          index > codexHeaderIndex &&
          /^(?:›\s*)?1\.\s*Yes,\s*proceed\b/i.test(line)
      );
      if (
        commandIndex >= 0 &&
        menuIndex > commandIndex
      ) {
        const command = lines
          .slice(commandIndex, menuIndex)
          .map((line) => line.replace(/^\$\s*/, ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (command) {
          return command;
        }
      }
    }

    const antigravityCommand = context.match(
      /\bRequesting\s*permission\s*for:\s*([\s\S]*?)\s*\bRun\s*this\s*command\?/i
    );
    if (antigravityCommand?.[1]) {
      return antigravityCommand[1].trim();
    }

    const commandPrompt = context.match(
      /\b(?:Allow|Run)\s+(?:this\s+)?command\?\s*(.*?)\s*(?:\[[^\]]+\]|\([^)]+\))?\s*:?\s*$/i
    );
    if (commandPrompt?.[1]) {
      return commandPrompt[1].trim();
    }

    const commandMatch = context.match(
      /(?:command|query)\s+["'“](.+?)["'”](?=\s*\??\s*(?:\[|\(|$))/i
    );
    if (commandMatch?.[1]) {
      return commandMatch[1].trim();
    }

    return lines.at(-1) ?? "CLI permission requested";
  }
}

export {
  CliStreamParser as StreamParser,
  CliStreamParser as PromptParser
};
