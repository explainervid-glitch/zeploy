// Plain script files: After Effects and Illustrator .jsx/.jsxbin, and
// Animate .jsfl.
//
// AE and Illustrator scripts go into each install under Program Files, so
// they need administrator rights. Animate commands go into the per-user
// Configuration folder, which Animate only creates the first time it runs.

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { emptyResult, PlanError, type Action, type HandlerResult, type PlanContext } from "../actions.ts";
import { APP_PROCESSES } from "../env.ts";
import type { AeScriptComponent, AiScriptComponent, JsflComponent } from "../manifest.ts";

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

// Illustrator lists the scripts in Presets\<language>\Scripts under
// File > Scripts. An install normally has one language folder ("en_US");
// the script goes into each one there is.
async function illustratorScriptDirs(dir: string): Promise<string[]> {
  const presets = join(dir, "Presets");
  const entries = await readdir(presets, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && /^[a-z]{2}_[A-Z]{2}$/.test(e.name)).map((e) => join(presets, e.name, "Scripts"));
}

export async function planAiScript(c: AiScriptComponent, ctx: PlanContext): Promise<HandlerResult> {
  const { env } = ctx;
  const installs = env.adobe.filter((a) => a.app === "illustrator");
  const targets = installs.filter((a) => matchesVersions(a.version, c.versions));
  if (targets.length === 0) {
    const found = installs.map((a) => a.version).join(", ") || "none";
    throw new PlanError(`no matching Illustrator install for ${c.source} (installed: ${found})`);
  }
  if (!env.isAdmin) {
    throw new PlanError("Illustrator scripts go under Program Files and need an elevated (administrator) process");
  }

  const result = emptyResult();
  result.actions.push({ kind: "ensureNotRunning", app: "illustrator", process: APP_PROCESSES.illustrator });
  const source = join(ctx.root, c.source);
  for (const ai of targets) {
    const dirs = await illustratorScriptDirs(ai.dir);
    if (dirs.length === 0) throw new PlanError(`no Presets\\<language> folder in ${ai.dir}`);
    for (const scripts of dirs) {
      const dest = join(scripts, basename(c.source));
      result.actions.push(await copyAction(source, dest));
      result.items.push({ kind: "path", path: dest });
    }
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
