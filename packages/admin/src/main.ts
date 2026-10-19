// The admin desktop app: starts the admin server inside Electron's main
// process and shows its UI in a window. The UI is the same page a browser on
// this computer gets from the server; Electron adds only a native folder
// picker (preload.cjs).
//
// Bundled to CommonJS by scripts/build.mjs, so no top-level await here.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyDir } from "../../core/src/index.ts";
import { DEFAULT_PORT } from "../../protocol/src/index.ts";
import { startServer, type RunningServer } from "../../server/src/server.ts";

// %APPDATA%\zeploy-admin, the same folder `npm run server` uses, so both
// ways of running the admin see the same packages and PCs.
migrateLegacyDir(join(app.getPath("appData"), "zdeploy-admin"), join(app.getPath("appData"), "zeploy-admin"));
app.setPath("userData", join(app.getPath("appData"), "zeploy-admin"));

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

// Where a picker opens: the folder the UI asks for, if it still exists.
function startFolder(path: unknown): string | undefined {
  if (typeof path !== "string" || !path || path.length > 1000) return undefined;
  return existsSync(path) ? path : undefined;
}

// The window buttons' colours: the UI's background and text (style.css),
// and the height of its top bar.
function theme(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#0D0F10", symbolColor: "#D8DCD6", height: 46 }
    : { color: "#F4F2EC", symbolColor: "#1C1E1F", height: 46 };
}

async function boot(): Promise<void> {
  const port = Number(process.env["ZEPLOY_PORT"] ?? DEFAULT_PORT);
  try {
    server = await startServer({
      dataDir: process.env["ZEPLOY_ADMIN_DATA"] ?? app.getPath("userData"),
      port,
      host: process.env["ZEPLOY_ADMIN_HOST"],
      uiDir: join(__dirname, "ui"),
      // Bundled by scripts/build.mjs for the one-click installer.
      agentExe: join(__dirname, "agent", "zeploy-agent.exe"),
    });
  } catch (err) {
    dialog.showErrorBox(
      "zeploy",
      `The admin server could not start: ${(err as Error).message}\n\n` +
        `Port ${port} may be in use, for example by another zeploy admin that is still running.`,
    );
    app.quit();
    return;
  }

  const adminUrl = server.adminUrl;
  ipcMain.handle("pick-folder", async (event, title: unknown, defaultPath: unknown) => {
    if (!event.senderFrame?.url.startsWith(adminUrl) || !win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: typeof title === "string" && title ? title.slice(0, 120) : "Choose a folder",
      defaultPath: startFolder(defaultPath),
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("pick-file", async (event, title: unknown, defaultPath: unknown) => {
    if (!event.senderFrame?.url.startsWith(adminUrl) || !win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: typeof title === "string" && title ? title.slice(0, 120) : "Choose a file",
      defaultPath: startFolder(defaultPath),
      properties: ["openFile"],
      filters: [
        { name: "Plugins and packages", extensions: ["zip", "zxp", "ccx", "jsx", "jsxbin", "jsfl", "py"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: "zeploy",
    autoHideMenuBar: true,
    backgroundColor: theme().color,
    // No Windows title bar: the UI's top bar takes its place (and is where
    // the window is dragged), while Windows still draws the minimise,
    // maximise and close buttons over its right end, in the UI's colours.
    titleBarStyle: "hidden",
    titleBarOverlay: theme(),
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
  // The UI follows the Windows light/dark setting; the buttons follow it too.
  nativeTheme.on("updated", () => {
    if (!win) return;
    win.setTitleBarOverlay(theme());
    win.setBackgroundColor(theme().color);
  });
  await win.loadURL(adminUrl);
}

app.on("window-all-closed", () => {
  void (server?.close() ?? Promise.resolve()).finally(() => app.quit());
});
