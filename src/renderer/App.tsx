import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PermissionRequestMessage,
  PetStateSnapshot,
  SessionInfo,
  SessionState
} from "../shared/protocol";
import MascotCanvas from "./components/MascotCanvas";
import PromptBubble from "./components/PromptBubble";

const initialSnapshot: PetStateSnapshot = { sessions: [] };

function aggregateState(sessions: SessionInfo[]): SessionState {
  if (sessions.some((session) => session.state === "ERROR")) {
    return "ERROR";
  }
  if (sessions.some((session) => session.state === "WAITING_PERMISSION")) {
    return "WAITING_PERMISSION";
  }
  if (sessions.some((session) => session.state === "WORKING")) {
    return "WORKING";
  }
  return "IDLE";
}

async function playNotification(): Promise<void> {
  let context: AudioContext | undefined;
  try {
    const AudioContextClass =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio is unavailable in this environment.");
    }

    const audioContext = new AudioContextClass();
    context = audioContext;
    await audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(988, audioContext.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.07,
      audioContext.currentTime + 0.015
    );
    gain.gain.setValueAtTime(0.07, audioContext.currentTime + 0.08);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + 0.1
    );
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime + 0.12);
    gain.gain.exponentialRampToValueAtTime(
      0.07,
      audioContext.currentTime + 0.135
    );
    gain.gain.setValueAtTime(0.07, audioContext.currentTime + 0.22);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + 0.26
    );
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.28);
    oscillator.addEventListener("ended", () => {
      void audioContext.close();
    });
  } catch (error) {
    console.error("Could not play AgentPet notification sound:", error);
    if (context && context.state !== "closed") {
      await context.close();
    }
  }
}

export default function App() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [queue, setQueue] = useState<PermissionRequestMessage[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  const previouslyPendingIds = useRef<Set<string>>(new Set());
  const currentQueue = useRef<PermissionRequestMessage[]>([]);

  useEffect(() => {
    const unsubscribeState = window.petAPI.onStateUpdate(setSnapshot);
    const unsubscribeQueue = window.petAPI.onQueueUpdate((nextQueue) => {
      if (currentQueue.current.length > 0 && nextQueue.length === 0) {
        window.petAPI.setIgnoreMouseEvents(true);
      }
      currentQueue.current = nextQueue;
      setQueue(nextQueue);
    });
    const unsubscribeMuted =
      window.petAPI.onNotificationsMuted(setNotificationsMuted);
    void window.petAPI
      .getNotificationsMuted()
      .then(setNotificationsMuted)
      .catch((error: unknown) => {
        console.error("Could not read AgentPet notification mute setting:", error);
      });
    return () => {
      unsubscribeState();
      unsubscribeQueue();
      unsubscribeMuted();
    };
  }, []);

  useEffect(() => {
    const currentIds = new Set(queue.map((request) => request.requestId));
    const hasNewRequest = queue.some(
      (request) => !previouslyPendingIds.current.has(request.requestId)
    );
    if (hasNewRequest && !notificationsMuted) {
      void playNotification();
    }
    previouslyPendingIds.current = currentIds;
    setQueueIndex((index) => (queue.length === 0 ? 0 : Math.min(index, queue.length - 1)));
  }, [notificationsMuted, queue]);

  const state = useMemo(
    () => aggregateState(snapshot.sessions),
    [snapshot.sessions]
  );

  const handleInteractiveEnter = useCallback(() => {
    window.petAPI.setIgnoreMouseEvents(false);
  }, []);

  const handleInteractiveLeave = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const relatedTarget = event.relatedTarget;
      if (
        relatedTarget instanceof Element &&
        relatedTarget.closest('[data-interactive-zone="true"]')
      ) {
        return;
      }
      const x = event.clientX;
      const y = event.clientY;
      window.requestAnimationFrame(() => {
        const target = document.elementFromPoint(x, y);
        if (!target?.closest('[data-interactive-zone="true"]')) {
          window.petAPI.setIgnoreMouseEvents(true);
        }
      });
    },
    []
  );

  return (
    <main className="relative flex h-full w-full flex-col items-end justify-end pb-2">
      <PromptBubble
        queue={queue}
        sessions={snapshot.sessions}
        index={queueIndex}
        onIndexChange={setQueueIndex}
        onInteractiveEnter={handleInteractiveEnter}
        onInteractiveLeave={handleInteractiveLeave}
      />
      <MascotCanvas
        state={state}
        activeSessionCount={snapshot.sessions.length}
        onInteractiveEnter={handleInteractiveEnter}
        onInteractiveLeave={handleInteractiveLeave}
      />
    </main>
  );
}
