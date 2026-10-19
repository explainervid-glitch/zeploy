// Runs in the sandboxed renderer before the admin UI. Exposes only the native
// pickers and the path of a dropped file or folder; the UI talks to the
// server over HTTP like a browser does.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zeployDesktop", {
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", String(title ?? "")),
  pickFile: (title) => ipcRenderer.invoke("pick-file", String(title ?? "")),
  // Empty for anything that is not a local file, which the UI then uploads.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
