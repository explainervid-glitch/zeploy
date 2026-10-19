// Runs in the sandboxed renderer before the admin UI. Exposes only the native
// pickers and the path of a dropped file or folder; the UI talks to the
// server over HTTP like a browser does.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zeployDesktop", {
  // defaultPath: the folder the picker opens in, such as the last one used.
  pickFolder: (title, defaultPath) => ipcRenderer.invoke("pick-folder", String(title ?? ""), String(defaultPath ?? "")),
  pickFile: (title, defaultPath) => ipcRenderer.invoke("pick-file", String(title ?? ""), String(defaultPath ?? "")),
  // Empty for anything that is not a local file, which the UI then uploads.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
