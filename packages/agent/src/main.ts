// zeploy-agent command line.
//
//   zeploy-agent setup --server <ip[:port]> --token <team token>   (administrator terminal)
//   zeploy-agent run                                               (what the Scheduled Task starts)
//   zeploy-agent configure --server ... --token ...
//   zeploy-agent status
//   zeploy-agent remove                                            (administrator terminal)
//   zeploy-agent version
//   zeploy-agent run --takeover <pid>                              (what an agent update starts)
//   zeploy-agent waker --home <agent folder> --user <DOMAIN\name>  (what the waker task starts, as SYSTEM)

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isElevated, migrateLegacyDir, run } from "../../core/src/index.ts";
import { WAKER_PORT, type AgentState } from "../../protocol/src/index.ts";
import { startAdmins } from "./admins.ts";
import { configPath, loadConfig, newAgentId, normalizeServerUrl, saveConfig, serversOf } from "./config.ts";
import { createProblems } from "./problems.ts";
import {
  currentUser,
  installedExePath,
  installWaker,
  LEGACY_TASK_NAME,
  legacyExeDir,
  registerTask,
  removeTask,
  removeWaker,
  startTask,
  TASK_NAME,
  WAKER_TASK_NAME,
} from "./task.ts";
import { exeUpdater, isAlive, NEXT_EXE, OLD_EXE } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";
import { CRASH_FILE, LOG_FILE, localWakerVersion, PID_FILE, startWaker } from "./waker.ts";

const USAGE = `zeploy-agent ${AGENT_VERSION}

  setup --server <ip[:port]> --token <team token>
        Install on this PC: copy to Program Files, save the settings and start
        at every logon of this user. Run from an administrator terminal.
  run [--server ...] [--token ...]
        Connect to the admin server and wait for jobs (what setup starts).
  configure --server <ip[:port]> --token <team token>
  status
  remove
        Stop the agent and the waker and remove their Scheduled Tasks
        (administrator terminal).
  waker --home <folder> --user <DOMAIN\\name>
        Answer the admin while the agent is not running (what the waker task
        starts; see waker.ts).
  version
        Print the version.
`;

// Same folder packages/core uses for receipts. An agent from before the
// rename to "zeploy" kept it under "zdeploy"; it moves over on first start.
const localAppData = process.env["LOCALAPPDATA"] ?? process.cwd();
const legacyStateDir = join(localAppData, "zdeploy");
const stateDir = process.env["ZEPLOY_HOME"] ?? join(localAppData, "zeploy");
if (!process.env["ZEPLOY_HOME"]) migrateLegacyDir(legacyStateDir, stateDir);
const logFile = join(stateDir, LOG_FILE);
const pidFile = join(stateDir, PID_FILE);
const crashFile = join(stateDir, CRASH_FILE);

function makeLogger(file = logFile): (line: string) => void {
  const logFile = file;
  mkdirSync(dirname(logFile), { recursive: true });
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

// zeploy-agent.old.exe stays locked until the agent it belonged to exits;
// .new.exe is left only by an update that crashed half-way.
async function removeUpdateLeftovers(oldPid: number | null): Promise<void> {
  for (let i = 0; oldPid && isAlive(oldPid) && i < 240; i++) await sleep(500);
  const dir = dirname(process.execPath);
  for (const name of [OLD_EXE, NEXT_EXE]) await rm(join(dir, name), { force: true }).catch(() => {});
}

async function cmdRun(values: { server?: string; token?: string; takeover?: string }): Promise<void> {
  const config = await configured(values);
  if (!config.serverUrl || !config.token) {
    throw new Error(`not configured; run: zeploy-agent configure --server <ip> --token <team token>`);
  }
  // Started by an agent update: the old agent keeps running, and keeps
  // agent.pid, until this one has connected.
  const takeover = values.takeover ? Number(values.takeover) : null;
  const other = runningPid();
  if (other && other !== takeover) throw new Error(`another agent is already running (pid ${other})`);
  const log = makeLogger();
  if (!takeover) writeFileSync(pidFile, String(process.pid));

  const servers = serversOf(config);
  log(`zeploy-agent ${AGENT_VERSION} starting, admin ${servers.join(", ")}${takeover ? `, taking over from pid ${takeover}` : ""}`);
  // Only the built exe can replace itself; from source, update with git.
  const updater = isSea() ? exeUpdater({ exe: process.execPath, pidFile }) : undefined;
  if (updater && !takeover) void removeUpdateLeftovers(null);
  let tookOver = !takeover;
  let connectedOnce = false;
  let waker: NonNullable<AgentState["waker"]> = { running: false };
  const problems = createProblems(() => agent?.report());
  const agent = startAdmins({
    servers,
    token: config.token,
    agentId: config.agentId!,
    log,
    updater,
    problems,
    waker: () => waker,
    // Plugins write their usage under %LOCALAPPDATA%\zeploy\usage.
    usageDir: join(stateDir, "usage"),
    // The first admin also goes into serverUrl, which older agents read.
    saveServers: async (list) => {
      const current = await loadConfig();
      await saveConfig({ ...current, serverUrl: list[0], servers: list });
    },
    onStatus: (_url, status) => {
      if (status === "connected" && !connectedOnce) {
        connectedOnce = true;
        // Running fine again: the waker stops reporting the last crash.
        rmSync(crashFile, { force: true });
      }
      if (status !== "connected" || tookOver) return;
      tookOver = true;
      // The old agent waits for this, then exits.
      writeFileSync(pidFile, String(process.pid));
      log(`took over from pid ${takeover}`);
      void removeUpdateLeftovers(takeover);
    },
    onReplaced: () => {
      log("a newer agent took over; exiting");
      process.exit(0);
    },
  });
  const shutdown = () => {
    log("stopping");
    void agent.stop().finally(() => {
      try {
        // After an update, agent.pid belongs to the new agent.
        if (Number(readFileSync(pidFile, "utf8")) === process.pid) unlinkSync(pidFile);
      } catch {}
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    log(`uncaught: ${err.stack ?? err.message}`);
    problems.record(`unexpected error: ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    log(`unhandled: ${(err as Error)?.stack ?? String(err)}`);
    problems.record(`unexpected error: ${(err as Error)?.message ?? String(err)}`);
  });

  waker = await ensureWaker(log);
  agent.report();
}

// Sets up the waker (waker.ts) unless the one running is this version. Needs
// an elevated agent: it registers a SYSTEM task and a firewall rule.
async function ensureWaker(log: (line: string) => void): Promise<NonNullable<AgentState["waker"]>> {
  if ((await localWakerVersion()) === AGENT_VERSION) return { running: true };
  if (!isSea()) return { running: false, error: "the agent runs from source; only zeploy-agent.exe sets up the waker" };
  if (!(await isElevated())) {
    return { running: false, error: "the agent runs without administrator rights; run the installer on this PC once to set up the waker" };
  }
  try {
    await installWaker(process.execPath, stateDir, currentUser(), WAKER_PORT);
    for (let i = 0; i < 30; i++) {
      if ((await localWakerVersion()) === AGENT_VERSION) {
        log(`waker ${AGENT_VERSION} set up`);
        return { running: true };
      }
      await sleep(500);
    }
    return { running: false, error: `the waker did not start; see ${wakerLogFile()}` };
  } catch (err) {
    const message = `could not set up the waker: ${(err as Error).message}`;
    log(message);
    return { running: false, error: message.slice(0, 500) };
  }
}

// Next to agent.json: the waker runs as SYSTEM, whose own folders nobody looks in.
const wakerLogFile = () => join(dirname(configPath()), "waker.log");

async function cmdWaker(values: { home?: string; user?: string }): Promise<void> {
  if (!values.home || !values.user) throw new Error("waker needs --home and --user");
  const log = makeLogger(wakerLogFile());
  await startWaker({ home: values.home, user: values.user, log });
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
  await installWaker(target, stateDir, currentUser(), WAKER_PORT);
  await startTask();
  console.log(`Installed ${target}`);
  console.log(`Settings  ${configPath()}`);
  console.log(`Task      "${TASK_NAME}" starts it at every logon of ${process.env["USERNAME"]}; it is running now.`);
  console.log(`Waker     "${WAKER_TASK_NAME}" runs from boot, so the admin can start the agent and read its log.`);
  console.log(`Log       ${logFile}`);
}

async function cmdRemove(): Promise<void> {
  if (!(await isElevated())) throw new Error("remove must be run from an administrator terminal");
  const removed = await removeTask();
  const wakerRemoved = await removeWaker();
  const pid = runningPid();
  if (pid) await run("taskkill", ["/F", "/PID", String(pid)]);
  console.log(removed ? `Removed the "${TASK_NAME}" task.` : `No "${TASK_NAME}" task was registered.`);
  if (wakerRemoved) console.log(`Removed the "${WAKER_TASK_NAME}" task and its firewall rule.`);
  if (pid) console.log(`Stopped the running agent (pid ${pid}).`);
  console.log(`Left in place: ${installedExePath()} and ${configPath()}`);
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const pid = runningPid();
  console.log(`version  ${AGENT_VERSION}`);
  console.log(`config   ${configPath()}`);
  console.log(`admin    ${serversOf(config).join(", ") || "(not set)"}`);
  console.log(`token    ${config.token ? "set" : "(not set)"}`);
  console.log(`agent id ${config.agentId ?? "(not assigned yet)"}`);
  console.log(`running  ${pid ? `yes, pid ${pid}` : "no"}`);
  const waker = await localWakerVersion();
  console.log(`waker    ${waker ? `running, version ${waker}` : "not running"}`);
  console.log(`log      ${logFile}`);
}

// For the waker, which tells the admin why the agent is not running.
function writeCrash(err: Error): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(crashFile, JSON.stringify({ at: new Date().toISOString(), error: err.message }));
  } catch {}
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      token: { type: "string" },
      takeover: { type: "string" },
      home: { type: "string" },
      user: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (values.version) {
    console.log(AGENT_VERSION);
    return;
  }
  switch (command) {
    case "version":
      // An agent update runs this on the downloaded exe before switching to it.
      console.log(AGENT_VERSION);
      return;
    case "run":
      try {
        return await cmdRun(values);
      } catch (err) {
        // Not a crash: a second start while the agent runs, as a Wake up can be.
        if (!/another agent is already running/.test((err as Error).message)) writeCrash(err as Error);
        throw err;
      }
    case "waker":
      return cmdWaker(values);
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
