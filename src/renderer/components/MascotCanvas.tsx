import { useEffect, useRef, useState } from "react";
import type { SessionState } from "../../shared/protocol";

interface MascotCanvasProps {
  state: SessionState;
  activeSessionCount: number;
  onInteractiveEnter: () => void;
  onInteractiveLeave: (event: React.MouseEvent<HTMLElement>) => void;
}

const spinnerFrames = ["> ( ⠋_⠙ )", "> ( ⠹_⠸ )"];
const microTextFrames = ["0xC1 01 10", "1010 0110"];

export default function MascotCanvas({
  state,
  activeSessionCount,
  onInteractiveEnter,
  onInteractiveLeave
}: MascotCanvasProps) {
  const dragPosition = useRef<{ x: number; y: number } | null>(null);
  const [workingFrame, setWorkingFrame] = useState(0);

  useEffect(() => {
    if (state !== "WORKING") {
      setWorkingFrame(0);
      return;
    }
    const timer = window.setInterval(() => {
      setWorkingFrame((frame) => (frame + 1) % spinnerFrames.length);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const previous = dragPosition.current;
      if (!previous) {
        return;
      }
      const deltaX = event.screenX - previous.x;
      const deltaY = event.screenY - previous.y;
      dragPosition.current = { x: event.screenX, y: event.screenY };
      window.petAPI.moveWindow(deltaX, deltaY);
    };
    const stopDragging = (): void => {
      dragPosition.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("blur", stopDragging);
    };
  }, []);

  const startDragging = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button === 0) {
      dragPosition.current = { x: event.screenX, y: event.screenY };
    }
  };

  const shellStateClass = {
    IDLE: "shell-idle",
    WORKING: "shell-working",
    WAITING_PERMISSION: "shell-alert",
    ERROR: "shell-error"
  }[state];
  const expression = {
    IDLE: "> ( -_- )",
    WORKING: spinnerFrames[workingFrame] ?? spinnerFrames[0],
    WAITING_PERMISSION: "> ( !_! )",
    ERROR: "> ( x_x )"
  }[state];

  return (
    <div className="relative flex h-[126px] w-[152px] shrink-0 items-end justify-end pr-5 pb-3">
      {activeSessionCount > 0 && (
        <div className="absolute bottom-5 left-0 z-10 rounded-full border border-cyan-300/30 bg-slate-950/95 px-2 py-1 font-mono text-[9px] font-bold tracking-wide text-cyan-200 shadow-lg shadow-cyan-950/50">
          {activeSessionCount} TTYs
        </div>
      )}
      <div
        className={`interactive-zone terminal-shell ${shellStateClass} relative flex h-[88px] w-24 select-none flex-col overflow-visible rounded-md border font-mono shadow-xl`}
        data-interactive-zone="true"
        onMouseDown={startDragging}
        onMouseEnter={onInteractiveEnter}
        onMouseLeave={onInteractiveLeave}
        role="presentation"
        title="Drag CLIa to reposition"
      >
        <div className="flex h-[19px] shrink-0 items-center gap-1 rounded-t-[5px] border-b border-white/5 bg-[#090D16] px-1.5">
          <span className="text-[8px] leading-none text-rose-400">●</span>
          <span className="text-[8px] leading-none text-amber-300">●</span>
          <span className="text-[8px] leading-none text-emerald-400">●</span>
          <span className="ml-auto text-[8px] tracking-tight text-slate-500">
            clia://tty
          </span>
        </div>

        {state === "WAITING_PERMISSION" && (
          <div className="permission-badge absolute -top-3 right-1 z-20 rounded border border-amber-400/70 bg-amber-950 px-1.5 py-0.5 text-[8px] font-bold text-amber-200 shadow-[0_0_10px_#f59e0b66]">
            [Y/N?]
          </div>
        )}

        <div className="terminal-screen scanlines relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-b-[5px] bg-[#020711] px-1">
          {state === "IDLE" && (
            <span className="sleep-particle absolute right-3 top-1 text-[9px] text-cyan-300/70">
              ~
            </span>
          )}
          <div className="whitespace-nowrap text-[10px] font-bold tracking-[-0.09em] text-cyan-200 drop-shadow-[0_0_5px_#22d3eeaa]">
            {expression}
            {state === "IDLE" && <span className="idle-cursor">▌</span>}
          </div>
          {state === "WORKING" && (
            <span className="mt-1 text-[7px] tracking-wide text-cyan-400/70">
              {microTextFrames[workingFrame] ?? microTextFrames[0]}
            </span>
          )}
          {state === "WAITING_PERMISSION" && (
            <span className="mt-1 text-[7px] tracking-[0.15em] text-amber-300/70">
              AWAITING INPUT
            </span>
          )}
          {state === "ERROR" && (
            <span className="mt-1 text-[7px] tracking-[0.15em] text-rose-400">
              PROCESS FAULT
            </span>
          )}
        </div>
      </div>
      <span className="thruster-base pointer-events-none absolute bottom-[4px] right-[39px] font-mono text-[12px] leading-none text-cyan-300">
        ╰══╯
      </span>
    </div>
  );
}
