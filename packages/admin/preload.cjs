// Runs in the sandboxed renderer before the admin UI. Exposes only the native
// folder picker; the UI talks to the server over HTTP like a browser does.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zeployDesktop", {
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", String(title ?? "")),
});
