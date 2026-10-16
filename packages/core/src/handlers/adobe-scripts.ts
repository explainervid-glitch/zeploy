// Plain script files: After Effects .jsx/.jsxbin and Animate .jsfl.
//
// AE scripts go into each AE install under Program Files, so they need
// administrator rights. Animate commands go into the per-user Configuration
// folder, which Animate only creates the first time it runs.

import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { emptyResult, PlanError, type Action, type HandlerResult, type PlanContext } from "../actions.ts";
import { APP_PROCESSES } from "../env.ts";
import type { AeScriptComponent, JsflComponent } from "../manifest.ts";

function matchesVersions(version: string, wanted: string[] | undefined): boolean {
  return !wanted?.length || wanted.includes(version);
}

async function copyAction(from: string, to: string): Promise<Action> {
  const isDir = (await stat(from)).isDirectory();
  return isDir ? { kind: "replaceDir", from, to, exclude: [] } : { kind: "copyFile", from, to };
}

export async function planAeScript(c: AeScriptComponent, ctx: PlanContext): Promise<HandlerResult> {
  const { env } = ctx;
  const installs = env.adobe.filter((a) => a.app === "aftereffects");
  const targets = installs.filter((a) => matchesVersions(a.version, c.versions));
  if (targets.length === 0) {
    const found = installs.map((a) => a.version).join(", ") || "none";
    throw new PlanError(`no matching After Effects install for ${c.source} (installed: ${found})`);
  }
  if (!env.isAdmin) {
    throw new PlanError("After Effects scripts go under Program Files and need an elevated (administrator) process");
  }

  const result = emptyResult();
  result.actions.push({ kind: "ensureNotRunning", app: "aftereffects", process: APP_PROCESSES.aftereffects });
  const source = join(ctx.root, c.source);
  for (const ae of targets) {
    const scripts = join(ae.dir, "Support Files", "Scripts");
    const folder = c.folder === "Scripts" ? scripts : join(scripts, c.folder);
    const dest = join(folder, basename(c.source));
    result.actions.push(await copyAction(source, dest));
    result.items.push({ kind: "path", path: dest });
  }
  return result;
}

export async function planJsfl(c: JsflComponent, ctx: PlanContext): Promise<HandlerResult> {
  const { env } = ctx;
  const targets = env.animateConfigs.filter((cfg) => matchesVersions(cfg.version, c.versions));
  if (targets.length === 0) {
    const installed = env.adobe.some((a) => a.app === "animate");
    throw new PlanError(
      installed
        ? `no Animate Configuration folder for ${c.source}; open Animate once so it creates one`
        : `Animate is not installed (needed for ${c.source})`,
    );
  }

  const result = emptyResult();
  result.actions.push({ kind: "ensureNotRunning", app: "animate", process: APP_PROCESSES.animate });
  const source = join(ctx.root, c.source);
  for (const cfg of targets) {
    const dest = join(cfg.dir, c.folder, basename(c.source));
    result.actions.push(await copyAction(source, dest));
    result.items.push({ kind: "path", path: dest });
  }
  return result;
}
