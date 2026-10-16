// Runs the admin server without Electron: open the printed URL in a browser
// on this computer. The Electron app starts the same server with the same
// data folder, so both see the same packages and PCs.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "../../protocol/src/index.ts";
import { startServer } from "./server.ts";

function defaultDataDir(): string {
  return join(process.env["APPDATA"] ?? process.cwd(), "zdeploy-admin");
}

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    data: { type: "string" },
    // 127.0.0.1 keeps the server off the LAN, e.g. for a local test.
    host: { type: "string" },
  },
});

const server = await startServer({
  dataDir: values.data ?? defaultDataDir(),
  port: values.port ? Number(values.port) : DEFAULT_PORT,
  host: values.host,
  uiDir: join(import.meta.dirname, "..", "ui"),
  // Built by npm run build:agent.
  agentExe: join(import.meta.dirname, "..", "..", "..", "dist", "agent", "zdeploy-agent.exe"),
});
console.log(`Admin UI: ${server.adminUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
