// The admin desktop app: starts the admin server inside Electron's main
// process and shows its UI in a window. The UI is the same page a browser on
// this computer gets from the server; Electron adds only a native folder
// picker (preload.cjs).
//
// Bundled to CommonJS by scripts/build.mjs, so no top-level await here.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { DEFAULT_PORT } from "../../protocol/src/index.ts";
import { startServer, type RunningServer } from "../../server/src/server.ts";

// %APPDATA%\zdeploy-admin, the same folder `npm run server` uses, so both
// ways of running the admin see the same packages and PCs.
app.setPath("userData", join(app.getPath("appData"), "zdeploy-admin"));

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(boot);
}

async function boot(): Promise<void> {
  const port = Number(process.env["ZDEPLOY_PORT"] ?? DEFAULT_PORT);
  try {
    server = await startServer({
      dataDir: process.env["ZDEPLOY_ADMIN_DATA"] ?? app.getPath("userData"),
      port,
      host: process.env["ZDEPLOY_ADMIN_HOST"],
      uiDir: join(__dirname, "ui"),
      // Bundled by scripts/build.mjs for the one-click installer.
      agentExe: join(__dirname, "agent", "zdeploy-agent.exe"),
    });
  } catch (err) {
    dialog.showErrorBox(
      "zdeploy",
      `The admin server could not start: ${(err as Error).message}\n\n` +
        `Port ${port} may be in use, for example by another zdeploy admin that is still running.`,
    );
    app.quit();
    return;
  }

  const adminUrl = server.adminUrl;
  ipcMain.handle("pick-folder", async (event, title: unknown) => {
    if (!event.senderFrame?.url.startsWith(adminUrl) || !win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: typeof title === "string" && title ? title.slice(0, 120) : "Choose a folder",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: "zdeploy",
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1d21" : "#e9eaed",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Only the admin UI is shown in this window; anything else goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(adminUrl)) event.preventDefault();
  });
  win.on("closed", () => (win = null));
  await win.loadURL(adminUrl);
}

app.on("window-all-closed", () => {
  void (server?.close() ?? Promise.resolve()).finally(() => app.quit());
});
