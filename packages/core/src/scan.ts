// Plugins already on a PC, whether zeploy installed them or not. The agent
// reports what it finds with the same keys packages carry (see infer.ts),
// so the admin app can show that a PC has a plugin before zeploy ever
// installed it there, for instance one copied by hand last year.
//
// Only reads folders; never runs Blender or an Adobe app.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Environment } from "./env.ts";
import { blenderUserDirs } from "./handlers/blender.ts";
import { normalizeVersion, parseBlInfo, scriptVersion } from "./infer.ts";

export interface FoundPlugin {
  // "cep:com.colosave.panel", as in InferredPlugin.key.
  key: string;
  version: string | null;
  // Where it was found, for people: "CEP, all users", "AE 2024 ScriptUI Panels".
  where: string;
}

const MAX_FOUND = 500;
const SCRIPT_FOLDERS = ["ScriptUI Panels", "Startup", "Shutdown"];

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function head(file: string, bytes = 8192): Promise<string> {
  const buf = await readFile(file).catch(() => null);
  return buf ? buf.subarray(0, bytes).toString("utf8") : "";
}

function tomlString(text: string, key: string): string | null {
  const top = text.split(/^\s*\[/m)[0] ?? "";
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(top)?.[1] ?? null;
}

async function scanCep(dir: string, where: string, out: FoundPlugin[]): Promise<void> {
  for (const e of await entries(dir)) {
    // A developer link is a junction or symlink; it counts as found too.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const xml = await head(join(dir, e.name, "CSXS", "manifest.xml"), 65536);
    const id = /ExtensionBundleId\s*=\s*"([^"]+)"/.exec(xml)?.[1];
    if (!id) continue;
    const version = /ExtensionBundleVersion\s*=\s*"([^"]+)"/.exec(xml)?.[1];
    out.push({ key: `cep:${id.toLowerCase()}`, version: normalizeVersion(version), where });
  }
}

async function scanScripts(dir: string, type: "ae-script" | "jsfl", where: string, out: FoundPlugin[]): Promise<void> {
  const wanted = type === "jsfl" ? /^\.jsfl$/i : /^\.(jsx|jsxbin)$/i;
  for (const e of await entries(dir)) {
    if (!e.isFile() || !wanted.test(extname(e.name))) continue;
    const version = /\.jsxbin$/i.test(e.name) ? null : scriptVersion(await head(join(dir, e.name)));
    out.push({ key: `${type}:${e.name.toLowerCase()}`, version, where });
  }
}

async function scanBlender(env: Environment, out: FoundPlugin[]): Promise<void> {
  for (const b of env.blender) {
    const dirs = await blenderUserDirs(b, env);
    const where = `Blender ${b.version}`;
    for (const e of await entries(dirs.addons)) {
      if (e.isFile() && /\.py$/i.test(e.name)) {
        const info = parseBlInfo(await head(join(dirs.addons, e.name), 65536));
        out.push({ key: `blender:${e.name.slice(0, -3).toLowerCase()}`, version: info.version, where });
      } else if (e.isDirectory() || e.isSymbolicLink()) {
        const init = await head(join(dirs.addons, e.name, "__init__.py"), 65536);
        if (!init) continue;
        out.push({ key: `blender:${e.name.toLowerCase()}`, version: parseBlInfo(init).version, where });
      }
    }
    // Extensions live in <extensions>\<repository>\<id>.
    for (const repo of await entries(dirs.extensions)) {
      if (!repo.isDirectory() || repo.name.startsWith(".")) continue;
      for (const e of await entries(join(dirs.extensions, repo.name))) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const toml = await head(join(dirs.extensions, repo.name, e.name, "blender_manifest.toml"), 65536);
        const id = tomlString(toml, "id");
        if (!id) continue;
        out.push({ key: `blender:${id.toLowerCase()}`, version: normalizeVersion(tomlString(toml, "version")), where });
      }
    }
  }
}

export async function scanInstalled(env: Environment): Promise<FoundPlugin[]> {
  const out: FoundPlugin[] = [];
  await scanCep(env.cep.system, "CEP, all users", out);
  await scanCep(env.cep.user, "CEP, this user", out);
  for (const ae of env.adobe.filter((a) => a.app === "aftereffects")) {
    const scripts = join(ae.dir, "Support Files", "Scripts");
    await scanScripts(scripts, "ae-script", `AE ${ae.version} Scripts`, out);
    for (const folder of SCRIPT_FOLDERS) {
      await scanScripts(join(scripts, folder), "ae-script", `AE ${ae.version} ${folder}`, out);
    }
  }
  for (const cfg of env.animateConfigs) {
    for (const folder of ["Commands", "Tools", "WindowSWF"]) {
      if ((await stat(join(cfg.dir, folder)).catch(() => null))?.isDirectory()) {
        await scanScripts(join(cfg.dir, folder), "jsfl", `Animate ${cfg.version} ${folder}`, out);
      }
    }
  }
  await scanBlender(env, out);
  return out.slice(0, MAX_FOUND);
}
