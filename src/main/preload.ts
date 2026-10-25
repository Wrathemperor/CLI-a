import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  PermissionRequestMessage,
  PetStateSnapshot
} from "../shared/protocol";

export interface PetApi {
  onStateUpdate(callback: (snapshot: PetStateSnapshot) => void): () => void;
  onQueueUpdate(
    callback: (queue: PermissionRequestMessage[]) => void
  ): () => void;
  onNotificationsMuted(callback: (muted: boolean) => void): () => void;
  getNotificationsMuted(): Promise<boolean>;
  sendDecision(
    sessionId: string,
    requestId: string,
    payload: string
  ): Promise<boolean>;
  setIgnoreMouseEvents(ignore: boolean): void;
  moveWindow(deltaX: number, deltaY: number): void;
  minimizeToTray(): void;
  quitApp(): void;
}

function subscribe<T>(
  channel: string,
  callback: (value: T) => void
): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => {
    callback(value);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const petApi: PetApi = {
  onStateUpdate: (callback) =>
    subscribe<PetStateSnapshot>("pet:state-update", callback),
  onQueueUpdate: (callback) =>
    subscribe<PermissionRequestMessage[]>("pet:queue-update", callback),
  onNotificationsMuted: (callback) =>
    subscribe<boolean>("pet:notifications-muted", callback),
  getNotificationsMuted: () =>
    ipcRenderer.invoke("pet:get-notifications-muted"),
  sendDecision: (sessionId, requestId, payload) =>
    ipcRenderer.invoke("pet:decision", sessionId, requestId, payload),
  setIgnoreMouseEvents: (ignore) =>
    ipcRenderer.send("pet:set-ignore-mouse-events", ignore),
  moveWindow: (deltaX, deltaY) =>
    ipcRenderer.send("pet:move-window", deltaX, deltaY),
  minimizeToTray: () => ipcRenderer.send("pet:minimize-to-tray"),
  quitApp: () => ipcRenderer.send("pet:quit-app")
};

contextBridge.exposeInMainWorld("petAPI", petApi);
