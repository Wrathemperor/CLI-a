import type {
  PermissionOption,
  PermissionRequestMessage,
  SessionInfo
} from "../../shared/protocol";

interface PromptBubbleProps {
  queue: PermissionRequestMessage[];
  sessions: SessionInfo[];
  index: number;
  onIndexChange: (index: number) => void;
  onInteractiveEnter: () => void;
  onInteractiveLeave: (event: React.MouseEvent<HTMLElement>) => void;
}

function commandName(command: string | undefined): string {
  if (!command) {
    return "cli";
  }
  const executable = command.trim().split(/\s+/, 1)[0] ?? command;
  return executable.split(/[\\/]/).filter(Boolean).at(-1) ?? executable;
}

function folderName(cwd: string | undefined): string {
  if (!cwd) {
    return "~";
  }
  const basename = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  return `~/${basename}`;
}

function optionClass(option: PermissionOption): string {
  if (option.style === "approve") {
    return "border-emerald-500 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 focus-visible:ring-emerald-300";
  }
  if (option.style === "deny") {
    return "border-rose-500 bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 focus-visible:ring-rose-300";
  }
  return "border-amber-500 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 focus-visible:ring-amber-300";
}

function optionLabel(option: PermissionOption): string {
  const payload = option.payload.replace(/[\r\n]/g, "").toLowerCase();
  if (option.style === "approve") {
    return `Approve (${payload === "allow" ? "y" : payload})`;
  }
  if (option.style === "deny") {
    return `Deny (${payload === "deny" ? "n" : payload})`;
  }
  return `${option.label} (${payload})`;
}

export default function PromptBubble({
  queue,
  sessions,
  index,
  onIndexChange,
  onInteractiveEnter,
  onInteractiveLeave
}: PromptBubbleProps) {
  const request = queue[index];
  if (!request) {
    return null;
  }

  const session = sessions.find((item) => item.sessionId === request.sessionId);
  const selectOption = async (option: PermissionOption): Promise<void> => {
    window.petAPI.setIgnoreMouseEvents(true);
    const accepted = await window.petAPI.sendDecision(
      request.sessionId,
      request.requestId,
      option.payload
    );
    if (!accepted) {
      console.error("AgentPet could not deliver the selected decision.");
      return;
    }
  };

  return (
    <section
      className="interactive-zone thought-cloud relative mx-3 mb-2 w-[calc(100vw-24px)] border border-amber-500/50 bg-zinc-950/95 p-4 font-mono text-zinc-100 shadow-2xl shadow-black/60 backdrop-blur-md"
      data-interactive-zone="true"
      onMouseEnter={onInteractiveEnter}
      onMouseLeave={onInteractiveLeave}
      aria-label="Permission request"
    >
      <span className="thought-tail thought-tail-large" aria-hidden="true" />
      <span className="thought-tail thought-tail-small" aria-hidden="true" />
      <header className="mb-3 flex items-center justify-between gap-2 border-b border-zinc-800/90 pb-2">
        <div className="min-w-0 truncate text-[11px] text-zinc-300">
          <span className="font-bold text-cyan-300">
            {commandName(session?.command)}
          </span>
          <span className="px-1 text-zinc-600">•</span>
          <span className="text-zinc-400">{folderName(session?.cwd)}</span>
        </div>
        {queue.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 text-[10px] text-amber-200">
            <button
              type="button"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
              onClick={() =>
                onIndexChange((index - 1 + queue.length) % queue.length)
              }
              aria-label="Previous prompt"
            >
              &lt;
            </button>
            <span className="min-w-8 text-center">
              [{index + 1}/{queue.length}]
            </span>
            <button
              type="button"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
              onClick={() => onIndexChange((index + 1) % queue.length)}
              aria-label="Next prompt"
            >
              &gt;
            </button>
          </div>
        )}
      </header>

      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
          What needs approval
        </h2>
        <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-200">
          [{request.toolName}]
        </span>
      </div>

      <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-black/80 p-2.5 text-xs leading-relaxed text-emerald-300 shadow-inner shadow-black/40">
        {request.summary}
      </div>

      {request.rawContext !== request.summary && (
        <details className="mt-2 text-[10px] text-zinc-500">
          <summary className="cursor-pointer select-none rounded-sm outline-none hover:text-zinc-300 focus-visible:ring-1 focus-visible:ring-cyan-300">
            raw context
          </summary>
          <pre className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-black/50 p-2 text-zinc-400">
            {request.rawContext}
          </pre>
        </details>
      )}

      <div className="mt-3 flex flex-wrap gap-2.5">
        {request.options.map((option) => (
          <button
            key={`${option.label}:${option.payload}`}
            type="button"
            className={`rounded-lg border px-3 py-2 text-[10px] font-bold transition-colors focus:outline-none focus-visible:ring-2 ${optionClass(option)}`}
            onClick={() => void selectOption(option)}
          >
            [{optionLabel(option)}]
          </button>
        ))}
      </div>
    </section>
  );
}
