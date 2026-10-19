// Agent self-update: puts a downloaded zeploy-agent.exe in place of the
// running one and hands over to it without a gap.
//
// Windows will not overwrite or delete a running exe, but it will rename
// one. So the running exe moves aside to zeploy-agent.old.exe, the new one
// takes its name, and the new agent starts with --takeover <this pid>. It
// connects to the admin server, which drops this agent's connection, and
// then writes its pid into agent.pid. This agent waits for that and exits.
// If the new agent does not get that far within a minute, it is stopped and
// the old exe goes back.
//
// The new agent runs outside the Scheduled Task until the next logon, when
// the task starts the (new) exe as usual.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "../../core/src/index.ts";

export interface AgentUpdater {
  // Resolves once the new agent has taken over; this process should then
  // exit. Throws, with the old exe back in place, if it did not.
  replace(file: string, version: string, log: (line: string) => void): Promise<void>;
}

export const NEXT_EXE = "zeploy-agent.new.exe";
export const OLD_EXE = "zeploy-agent.old.exe";

const TAKEOVER_MS = 60_000;

function pidIn(file: string): number | null {
  try {
    return Number(readFileSync(file, "utf8")) || null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A killed process holds its exe for a moment after it is gone.
async function retry(fn: () => Promise<void>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(250);
    }
  }
}

export function exeUpdater(options: { exe: string; pidFile: string; takeoverMs?: number }): AgentUpdater {
  const { exe, pidFile } = options;
  const takeoverMs = options.takeoverMs ?? TAKEOVER_MS;
  const dir = dirname(exe);
  const next = join(dir, NEXT_EXE);
  const old = join(dir, OLD_EXE);

  async function putBack(): Promise<void> {
    await retry(() => rm(exe, { force: true }));
    await rename(old, exe);
  }

  async function tookOver(): Promise<boolean> {
    const end = Date.now() + takeoverMs;
    while (Date.now() < end) {
      const pid = pidIn(pidFile);
      if (pid && pid !== process.pid && isAlive(pid)) return true;
      await sleep(500);
    }
    return false;
  }

  return {
    async replace(file, version, log) {
      await copyFile(file, next);
      // A broken or truncated exe fails here, before anything is replaced.
      const check = await run(next, ["version"], { timeoutMs: 30_000 }).catch((err: Error) => ({
        code: -1,
        stdout: "",
        stderr: err.message,
      }));
      if (check.code !== 0 || check.stdout.trim() !== version) {
        await rm(next, { force: true });
        const said = (check.stderr || check.stdout).trim().split("\n")[0] || `exit code ${check.code}`;
        throw new Error(`the downloaded agent did not report version ${version} (${said})`);
      }

      // Left by the previous update if its agent could not delete it.
      await rm(old, { force: true });
      await rename(exe, old);
      try {
        await rename(next, exe);
      } catch (err) {
        await rename(old, exe);
        throw err;
      }
      log(`replaced ${exe}, starting agent ${version}`);

      // Detached, the new agent has no console at all, so nothing shows; the
      // tools it runs hide their own (windowsHide in core's run()). Not via
      // conhost --headless like the Scheduled Task: that exits at once when
      // its standard handles are NUL, and with pipes it would die with this
      // process.
      const child = spawn(exe, ["run", "--takeover", String(process.pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      try {
        await new Promise<void>((resolveSpawn, reject) => {
          child.once("spawn", resolveSpawn);
          child.once("error", reject);
        });
      } catch (err) {
        await putBack();
        throw new Error(`could not start agent ${version}: ${(err as Error).message}`);
      }
      child.unref();

      if (await tookOver()) return;

      log(`agent ${version} did not connect within ${takeoverMs / 1000} s; putting the old agent back`);
      if (child.pid) await run("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
      await putBack();
      throw new Error(`agent ${version} did not connect within ${takeoverMs / 1000} s, so this PC keeps the old agent`);
    },
  };
}
