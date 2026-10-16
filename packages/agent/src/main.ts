// zeploy-agent command line.
//
//   zeploy-agent setup --server <ip[:port]> --token <team token>   (administrator terminal)
//   zeploy-agent run                                               (what the Scheduled Task starts)
//   zeploy-agent configure --server ... --token ...
//   zeploy-agent status
//   zeploy-agent remove                                            (administrator terminal)

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { parseArgs } from "node:util";
import { isElevated, migrateLegacyDir, run } from "../../core/src/index.ts";
import { AGENT_VERSION, startAgent } from "./agent.ts";
import { configPath, loadConfig, newAgentId, normalizeServerUrl, saveConfig } from "./config.ts";
import {
  installedExePath,
  LEGACY_TASK_NAME,
  legacyExeDir,
  registerTask,
  removeTask,
  startTask,
  TASK_NAME,
} from "./task.ts";

const USAGE = `zeploy-agent ${AGENT_VERSION}

  setup --server <ip[:port]> --token <team token>
        Install on this PC: copy to Program Files, save the settings and start
        at every logon of this user. Run from an administrator terminal.
  run [--server ...] [--token ...]
        Connect to the admin server and wait for jobs (what setup starts).
  configure --server <ip[:port]> --token <team token>
  status
  remove
        Stop the agent and remove its Scheduled Task (administrator terminal).
`;

// Same folder packages/core uses for receipts. An agent from before the
// rename to "zeploy" kept it under "zdeploy"; it moves over on first start.
const localAppData = process.env["LOCALAPPDATA"] ?? process.cwd();
const legacyStateDir = join(localAppData, "zdeploy");
const stateDir = process.env["ZEPLOY_HOME"] ?? join(localAppData, "zeploy");
if (!process.env["ZEPLOY_HOME"]) migrateLegacyDir(legacyStateDir, stateDir);
const logFile = join(stateDir, "agent.log");
const pidFile = join(stateDir, "agent.pid");

function makeLogger(): (line: string) => void {
  mkdirSync(stateDir, { recursive: true });
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
      if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) {
        renameSync(logFile, `${logFile}.1`);
      }
      appendFileSync(logFile, stamped + "\n");
    } catch {
      // Logging must never stop the agent.
    }
  };
}

function runningPid(file = pidFile): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function configured(values: { server?: string; token?: string }) {
  const config = await loadConfig();
  let dirty = false;
  if (values.server) {
    config.serverUrl = normalizeServerUrl(values.server);
    dirty = true;
  }
  if (values.token) {
    config.token = values.token;
    dirty = true;
  }
  if (!config.agentId) {
    config.agentId = newAgentId();
    dirty = true;
  }
  if (dirty) await saveConfig(config);
  return config;
}

async function checkServer(serverUrl: string): Promise<void> {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`cannot reach the admin server at ${serverUrl} (${(err as Error).message})`);
  }
}

async function cmdRun(values: { server?: string; token?: string }): Promise<void> {
  const config = await configured(values);
  if (!config.serverUrl || !config.token) {
    throw new Error(`not configured; run: zeploy-agent configure --server <ip> --token <team token>`);
  }
  const other = runningPid();
  if (other) throw new Error(`another agent is already running (pid ${other})`);
  const log = makeLogger();
  writeFileSync(pidFile, String(process.pid));

  log(`zeploy-agent ${AGENT_VERSION} starting, server ${config.serverUrl}`);
  const agent = startAgent({ serverUrl: config.serverUrl, token: config.token, agentId: config.agentId!, log });
  const shutdown = () => {
    log("stopping");
    void agent.stop().finally(() => {
      try {
        unlinkSync(pidFile);
      } catch {}
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => log(`unhandled: ${(err as Error)?.stack ?? String(err)}`));
}

// An agent installed before the rename to "zeploy" ran as "zdeploy": its own
// Scheduled Task, process and Program Files folder. Its settings and records
// were already moved over by migrateLegacyDir; this removes the rest so the
// PC does not run two agents.
async function removeLegacyInstall(): Promise<void> {
  if (await removeTask(LEGACY_TASK_NAME)) console.log(`Removed the old "${LEGACY_TASK_NAME}" task.`);
  const pid = runningPid(join(legacyStateDir, "agent.pid"));
  if (pid) await run("taskkill", ["/F", "/PID", String(pid)]);
  const legacyDir = legacyExeDir();
  if (existsSync(legacyDir)) {
    try {
      await rm(legacyDir, { recursive: true, force: true });
      console.log(`Removed ${legacyDir}`);
    } catch {
      console.log(`Could not remove ${legacyDir}; delete it after restarting this PC.`);
    }
  }
}

async function cmdSetup(values: { server?: string; token?: string }): Promise<void> {
  if (!values.server || !values.token) throw new Error("setup needs --server and --token");
  if (!isSea()) throw new Error("setup must be run from the built zeploy-agent.exe (npm run build:agent)");
  if (!(await isElevated())) throw new Error("setup must be run from an administrator terminal");

  const serverUrl = normalizeServerUrl(values.server);
  await checkServer(serverUrl);
  await configured({ server: serverUrl, token: values.token });

  const target = installedExePath();
  if (resolve(process.execPath).toLowerCase() !== target.toLowerCase()) {
    const pid = runningPid();
    if (pid) await run("taskkill", ["/F", "/PID", String(pid)]);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(process.execPath, target);
  }
  await removeLegacyInstall();
  await registerTask(target);
  await startTask();
  console.log(`Installed ${target}`);
  console.log(`Settings  ${configPath()}`);
  console.log(`Task      "${TASK_NAME}" starts it at every logon of ${process.env["USERNAME"]}; it is running now.`);
  console.log(`Log       ${logFile}`);
}

async function cmdRemove(): Promise<void> {
  if (!(await isElevated())) throw new Error("remove must be run from an administrator terminal");
  const removed = await removeTask();
  const pid = runningPid();
  if (pid) await run("taskkill", ["/F", "/PID", String(pid)]);
  console.log(removed ? `Removed the "${TASK_NAME}" task.` : `No "${TASK_NAME}" task was registered.`);
  if (pid) console.log(`Stopped the running agent (pid ${pid}).`);
  console.log(`Left in place: ${installedExePath()} and ${configPath()}`);
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const pid = runningPid();
  console.log(`config   ${configPath()}`);
  console.log(`server   ${config.serverUrl ?? "(not set)"}`);
  console.log(`token    ${config.token ? "set" : "(not set)"}`);
  console.log(`agent id ${config.agentId ?? "(not assigned yet)"}`);
  console.log(`running  ${pid ? `yes, pid ${pid}` : "no"}`);
  console.log(`log      ${logFile}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command] = positionals;
  switch (command) {
    case "run":
      return cmdRun(values);
    case "setup":
      return cmdSetup(values);
    case "configure": {
      if (!values.server || !values.token) throw new Error("configure needs --server and --token");
      const config = await configured(values);
      await checkServer(config.serverUrl!).catch((err: Error) => console.log(`warning: ${err.message}`));
      console.log(`Saved ${configPath()}`);
      return;
    }
    case "status":
      return cmdStatus();
    case "remove":
      return cmdRemove();
    default:
      console.log(USAGE);
      if (!values.help) process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
