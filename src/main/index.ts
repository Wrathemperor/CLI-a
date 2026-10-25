import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray
} from "electron";
import path from "node:path";
import type { WebSocketHub } from "./ws-server";
import { createWebSocketHub } from "./ws-server";

const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 420;
const WINDOW_MARGIN = 24;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let hub: WebSocketHub | undefined;
let isQuitting = false;
let notificationsMuted = false;

function getBottomRightPosition(): [number, number] {
  const { workArea } = screen.getPrimaryDisplay();
  return [
    workArea.x + workArea.width - WINDOW_WIDTH - WINDOW_MARGIN,
    workArea.y + workArea.height - WINDOW_HEIGHT - WINDOW_MARGIN
  ];
}

function resetWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const [x, y] = getBottomRightPosition();
  mainWindow.setPosition(x, y);
}

function createTray(): void {
  const iconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#7c3aed"/><circle cx="11" cy="14" r="2" fill="white"/><circle cx="21" cy="14" r="2" fill="white"/><path d="M11 21q5 5 10 0" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>';
  tray = new Tray(
    nativeImage.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg)}`
    )
  );
  tray.setToolTip("AgentPet");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Reset Position", click: resetWindowPosition },
      {
        label: "Mute Notifications",
        type: "checkbox",
        checked: notificationsMuted,
        click: (item) => {
          notificationsMuted = item.checked;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              "pet:notifications-muted",
              notificationsMuted
            );
          }
        }
      },
      { type: "separator" },
      {
        label: "Quit CLIa",
        click: () => {
          app.quit();
        }
      }
    ])
  );
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive();
    }
  });
}

function createWindow(): void {
  const [x, y] = getBottomRightPosition();
  mainWindow = new BrowserWindow({
    x,
    y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed() || !hub) {
      return;
    }
    mainWindow.webContents.send("pet:state-update", {
      sessions: Array.from(hub.sessions.values())
    });
    mainWindow.webContents.send("pet:queue-update", hub.pendingQueue.slice());
    mainWindow.webContents.send(
      "pet:notifications-muted",
      notificationsMuted
    );
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  const rendererLoad = process.env.VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    : mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  rendererLoad.catch((error: unknown) => {
    console.error("Failed to load AgentPet renderer:", error);
    app.quit();
  });
  mainWindow.showInactive();
}

function registerIpcHandlers(): void {
  ipcMain.on("pet:set-ignore-mouse-events", (_event, ignore: unknown) => {
    if (typeof ignore !== "boolean") {
      return;
    }
    mainWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.on(
    "pet:move-window",
    (_event, deltaX: unknown, deltaY: unknown) => {
      if (
        !mainWindow ||
        typeof deltaX !== "number" ||
        !Number.isFinite(deltaX) ||
        typeof deltaY !== "number" ||
        !Number.isFinite(deltaY)
      ) {
        return;
      }
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY));
    }
  );

  ipcMain.handle(
    "pet:decision",
    (_event, sessionId: unknown, requestId: unknown, payload: unknown) => {
      if (
        typeof sessionId !== "string" ||
        typeof requestId !== "string" ||
        typeof payload !== "string"
      ) {
        return false;
      }
      return hub?.dispatchDecision(sessionId, requestId, payload) ?? false;
    }
  );
  ipcMain.handle("pet:get-notifications-muted", () => notificationsMuted);

  ipcMain.on("pet:minimize-to-tray", () => {
    mainWindow?.hide();
  });
  ipcMain.on("pet:quit-app", () => {
    app.quit();
  });
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    hub = createWebSocketHub({
      getRenderer: () => {
        const contents = mainWindow?.webContents;
        if (!contents || contents.isDestroyed()) {
          return undefined;
        }
        return contents;
      }
    });
    hub.server.once("error", (error) => {
      console.error("Failed to start AgentPet WebSocket server:", error);
      app.quit();
    });
    createWindow();
    createTray();

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
      } else {
        mainWindow.showInactive();
      }
    });
  }).catch((error: unknown) => {
    console.error("Failed to initialize AgentPet:", error);
    app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("will-quit", () => {
    ipcMain.removeAllListeners("pet:set-ignore-mouse-events");
    ipcMain.removeAllListeners("pet:move-window");
    ipcMain.removeAllListeners("pet:minimize-to-tray");
    ipcMain.removeAllListeners("pet:quit-app");
    ipcMain.removeHandler("pet:decision");
    ipcMain.removeHandler("pet:get-notifications-muted");
    tray?.destroy();
    if (hub) {
      void hub.close().catch((error: unknown) => {
        console.error("Failed to stop AgentPet WebSocket server:", error);
      });
    }
  });
} else {
  app.quit();
}
