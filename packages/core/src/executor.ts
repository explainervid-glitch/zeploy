// Carries out a Plan, or describes it in a dry run.

import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Action, Plan } from "./actions.ts";
import { APP_LABELS, type AppId } from "./env.ts";
import { removeSafe, replaceDir } from "./fsutil.ts";
import { killProcess, listProcesses, regSetString, run } from "./win.ts";

// What to do when an app the plan touches is open.
export type IfRunning = "fail" | "kill" | "ignore";

export interface ExecuteOptions {
  dryRun: boolean;
  ifRunning: IfRunning;
  log: (line: string) => void;
  // Injected by tests; defaults to tasklist.
  processes?: () => Promise<Set<string>>;
  // Injected by tests; defaults to taskkill.
  kill?: (imageName: string) => Promise<void>;
}

export class AppRunningError extends Error {
  override name = "AppRunningError";
  readonly apps: AppId[];
  constructor(apps: AppId[]) {
    super(
      `close ${apps.map((a) => APP_LABELS[a]).join(", ")} first ` +
        `(or pass --if-running kill to close it, losing unsaved work)`,
    );
    this.apps = apps;
  }
}

export class ExecError extends Error {
  override name = "ExecError";
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "ensureNotRunning":
      return `check ${APP_LABELS[a.app]} is closed (${a.process})`;
    case "replaceDir":
      return `copy folder  ${a.from}\n          -> ${a.to}`;
    case "copyFile":
      return `copy file    ${a.from}\n          -> ${a.to}`;
    case "removePath":
      return `remove       ${a.path}  (${a.reason})`;
    case "setRegistry":
      return `registry     ${a.key} ${a.name}=${a.value}`;
    case "exec":
      return `run          ${a.label}`;
  }
}

function tail(text: string, lines = 15): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

async function checkRunning(plan: Plan, options: ExecuteOptions): Promise<void> {
  const checks = plan.actions.filter((a) => a.kind === "ensureNotRunning");
  if (checks.length === 0) return;
  const running = await (options.processes ?? listProcesses)();
  const open = checks.filter((a) => running.has(a.process.toLowerCase()));
  if (open.length === 0) return;

  const names = open.map((a) => APP_LABELS[a.app]).join(", ");
  if (options.dryRun) {
    options.log(`  [!] ${names} is running; a real install would ${options.ifRunning === "fail" ? "stop here" : options.ifRunning === "kill" ? "close it" : "continue anyway"}`);
    return;
  }
  if (options.ifRunning === "fail") throw new AppRunningError(open.map((a) => a.app));
  if (options.ifRunning === "ignore") {
    options.log(`  [!] ${names} is running; restart it afterwards`);
    return;
  }
  for (const a of open) {
    options.log(`  closing ${APP_LABELS[a.app]}...`);
    await (options.kill ?? killProcess)(a.process);
  }
  // Give the processes a moment to release their files.
  await new Promise((r) => setTimeout(r, 1500));
}

async function runAction(a: Action): Promise<void> {
  switch (a.kind) {
    case "ensureNotRunning":
      return;
    case "replaceDir":
      return replaceDir(a.from, a.to, a.exclude);
    case "copyFile":
      await mkdir(dirname(a.to), { recursive: true });
      return copyFile(a.from, a.to);
    case "removePath":
      await removeSafe(a.path);
      return;
    case "setRegistry":
      return regSetString(a.key, a.name, a.value);
    case "exec": {
      const r = await run(a.file, a.args, { timeoutMs: a.timeoutMs });
      if (r.code !== 0 && !(a.tolerate && new RegExp(a.tolerate).test(r.stdout + r.stderr))) {
        throw new ExecError(`${a.label} failed (exit ${r.code}):\n${tail(r.stderr + "\n" + r.stdout)}`);
      }
      return;
    }
  }
}

export async function executePlan(plan: Plan, options: ExecuteOptions): Promise<void> {
  for (const w of plan.warnings) options.log(`  [!] ${w}`);
  await checkRunning(plan, options);

  const steps = plan.actions.filter((a) => a.kind !== "ensureNotRunning");
  // Registry writes are listed as one line; there are many and they are alike.
  const regs = steps.filter((a) => a.kind === "setRegistry");
  let regLogged = false;

  for (const a of steps) {
    if (a.kind === "setRegistry") {
      if (!regLogged) {
        options.log(`  ${options.dryRun ? "would set" : "set"} PlayerDebugMode=1 for ${regs.length} CSXS version(s)`);
        regLogged = true;
      }
    } else {
      options.log(`  ${options.dryRun ? "would " : ""}${describeAction(a)}`);
    }
    if (!options.dryRun) await runAction(a);
  }
}
