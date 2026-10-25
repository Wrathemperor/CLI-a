export type SessionState =
  | "IDLE"
  | "WORKING"
  | "WAITING_PERMISSION"
  | "ERROR";

export type PermissionOptionStyle = "approve" | "deny" | "neutral";

export interface PermissionOption {
  label: string;
  payload: string;
  style: PermissionOptionStyle;
}

export interface RegisterMessage {
  type: "REGISTER";
  sessionId: string;
  command: string;
  pid: number;
  cwd: string;
}

export interface StateUpdateMessage {
  type: "STATE_UPDATE";
  sessionId: string;
  state: SessionState;
}

export interface PermissionRequestMessage {
  type: "PERMISSION_REQUEST";
  sessionId: string;
  requestId: string;
  toolName: string;
  summary: string;
  rawContext: string;
  options: PermissionOption[];
}

export interface UnregisterMessage {
  type: "UNREGISTER";
  sessionId: string;
  exitCode: number;
}

export type CliToMascotMessage =
  | RegisterMessage
  | StateUpdateMessage
  | PermissionRequestMessage
  | UnregisterMessage;

export interface PermissionResponseMessage {
  type: "PERMISSION_RESPONSE";
  sessionId: string;
  requestId: string;
  payload: string;
}

export type MascotToCliMessage = PermissionResponseMessage;
export type ProtocolMessage = CliToMascotMessage | MascotToCliMessage;

export interface PromptRule {
  pattern: RegExp;
  options: PermissionOption[];
}

export interface PromptProfile {
  id: string;
  name: string;
  commandPattern: RegExp;
  rules: PromptRule[];
}

export interface SessionInfo {
  sessionId: string;
  command: string;
  pid: number;
  cwd: string;
  state: SessionState;
}

export interface PetStateSnapshot {
  sessions: SessionInfo[];
}

const approveDenyOptions: PermissionOption[] = [
  { label: "Yes", payload: "y\r", style: "approve" },
  { label: "No", payload: "n\r", style: "deny" }
];

export const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    commandPattern: /(?:^|[\\/])claude(?:\.cmd)?(?:\s|$)/i,
    rules: [
      {
        pattern:
          /(?:Do you want to proceed\?|Do you want to make this edit to)[\s\S]*?\b1\.\s*Yes\b[\s\S]*?\b2\.\s*Yes\b[\s\S]*?\b3\.\s*No\b/i,
        options: [
          { label: "Yes [1]", payload: "1", style: "approve" },
          { label: "Yes, and don't ask again [2]", payload: "2", style: "neutral" },
          { label: "No [3]", payload: "3", style: "deny" }
        ]
      },
      {
        pattern:
          /(?:allow|run|execute|proceed)[^\r\n]*\[\s*y\s*\/\s*n\s*\/\s*a\s*\]\s*:?\s*$/i,
        options: [
          ...approveDenyOptions,
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /(?:allow|run|execute|proceed)[^\r\n]*(?:\[[^\]]*[yn][^\]]*\]|\([^)]+[yn][^)]+\))\s*:\s*$/i,
        options: approveDenyOptions
      },
      {
        pattern: /1\.\s*(?:yes|approve)[\s\S]*2\.\s*(?:no|deny)/i,
        options: [
          { label: "Yes", payload: "1", style: "approve" },
          { label: "No", payload: "2", style: "deny" }
        ]
      },
      {
        pattern: /proceed\?\s*$/i,
        options: approveDenyOptions
      }
    ]
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    commandPattern: /(?:^|[\\/])codex(?:\.exe|\.cmd)?(?:\s|$)/i,
    rules: [
      {
        pattern:
          /(?:Would\s*you\s*like\s*to\s*run\s*the\s*following\s*command\?|Would\s*you\s*like\s*to\s*apply[\s\S]{0,80}(?:patch|edit|changes?)|(?:apply|run)\s+(?:this\s+)?(?:patch|edit|changes?|command))[\s\S]*(?:Press\s*enter\s*to\s*confirm\s*or\s*esc\s*to\s*cancel|1\.\s*Yes,\s*proceed)/i,
        options: [
          { label: "Approve [1 / y]", payload: "\r", style: "approve" },
          { label: "Always Allow [2 / p]", payload: "p", style: "neutral" },
          { label: "Cancel [3 / Esc]", payload: "\u001b", style: "deny" }
        ]
      },
      {
        pattern:
          /Would\s*you\s*like\s*to\s*run\s*the\s*following\s*command\?[\s\S]*?\b1\.\s*Yes,\s*proceed/i,
        options: [
          { label: "Approve [1 / y]", payload: "\r", style: "approve" },
          { label: "Always Allow [2 / p]", payload: "p", style: "neutral" },
          { label: "Cancel [3 / Esc]", payload: "\u001b", style: "deny" }
        ]
      },
      {
        pattern:
          /(?:Allow|Run)\s+(?:this\s+)?(?:command|tool)[^\r\n]*\[\s*y\s*\/\s*n\s*\/\s*a\s*\]/i,
        options: [
          { label: "Yes", payload: "y\r", style: "approve" },
          { label: "No", payload: "n\r", style: "deny" },
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /(?:Allow|Run)\s+(?:this\s+)?(?:command|tool)[^\r\n]*\[\s*y\s*\/\s*n\s*\]/i,
        options: approveDenyOptions
      },
      {
        pattern:
          /(?:Allow|Run)\s+(?:this\s+)?(?:command|tool)[^\r\n]*\(\s*y\s*\)\s*es\s*\/\s*\(\s*n\s*\)\s*o\s*\/\s*\(\s*a\s*\)\s*lways/i,
        options: [
          { label: "Yes", payload: "y\r", style: "approve" },
          { label: "No", payload: "n\r", style: "deny" },
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /(?:Allow|Run)\s+(?:this\s+)?(?:command|tool)[^\r\n]*\(\s*y\s*\)\s*es\s*\/\s*\(\s*n\s*\)\s*o/i,
        options: approveDenyOptions
      },
      {
        pattern: /(?:Allow|Run)\s+(?:this\s+)?command\?\s*$/i,
        options: approveDenyOptions
      }
    ]
  },
  {
    id: "aider",
    name: "Aider",
    commandPattern: /(?:^|[\\/])aider(?:\.exe)?(?:\s|$)/i,
    rules: [
      {
        pattern:
          /\([yY]\)es\s*\/\s*\([nN]\)o(?:\s*[,/]?\s*\([dD]\)on't ask again)\s*[:?]?\s*$/i,
        options: [
          { label: "Yes", payload: "y\r", style: "approve" },
          { label: "No", payload: "n\r", style: "deny" },
          { label: "Don't ask again", payload: "d\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /\([yY]\)es\s*\/\s*\([nN]\)o(?:\s*\/\s*\([aA]\)lways)\s*[:?]?\s*$/i,
        options: [
          { label: "Yes", payload: "y\r", style: "approve" },
          { label: "No", payload: "n\r", style: "deny" },
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      }
    ]
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    commandPattern: /(?:^|[\\/])agy(?:\.exe|\.cmd)?(?:\s|$)/i,
    rules: [
      {
        pattern:
          /\bRequesting\s*permission\s*for:[\s\S]*?\bRun\s*this\s*command\?[\s\S]*?\b1\.(?:\s*Yes\b)?/i,
        options: [
          { label: "Approve [1]", payload: "1\r", style: "approve" },
          { label: "Always (Session) [2]", payload: "2\r", style: "neutral" },
          {
            label: "Always (Persist) [3]",
            payload: "3\r",
            style: "neutral"
          },
          { label: "Cancel [4 / Esc]", payload: "\u001b", style: "deny" }
        ]
      }
    ]
  },
  {
    id: "generic",
    name: "Generic yes/no prompt",
    commandPattern: /[\s\S]*/,
    rules: [
      {
        pattern:
          /\[\s*y\s*\/\s*n\s*\/\s*a\s*\]\s*:?\s*$/i,
        options: [
          ...approveDenyOptions,
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /\(\s*y\s*\)\s*es\s*\/\s*\(\s*n\s*\)\s*o\s*\/\s*\(\s*a\s*\)\s*lways\s*:?\s*$/i,
        options: [
          { label: "Yes", payload: "y\r", style: "approve" },
          { label: "No", payload: "n\r", style: "deny" },
          { label: "Always", payload: "a\r", style: "neutral" }
        ]
      },
      {
        pattern:
          /\(\s*y\s*\)\s*es\s*\/\s*\(\s*n\s*\)\s*o\s*:?\s*$/i,
        options: approveDenyOptions
      },
      {
        pattern:
          /(?:\[\s*y\s*\/\s*n\s*\]|\[\s*Y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n[^)]*\))\s*:?\s*$/i,
        options: approveDenyOptions
      },
      {
        pattern: /1\.\s*(?:yes|approve)[\s\S]*2\.\s*(?:no|deny)/i,
        options: [
          { label: "Yes", payload: "1\r", style: "approve" },
          { label: "No", payload: "2\r", style: "deny" }
        ]
      },
      {
        pattern: /proceed\?\s*$/i,
        options: approveDenyOptions
      }
    ]
  }
];
