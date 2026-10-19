// Packages without zeploy.json. Most plugins already say who they are in
// their own files, so zeploy reads the id, name and version from there:
//
//   CEP panel folder        CSXS/manifest.xml
//   .zxp                    CSXS/manifest.xml inside it
//   .ccx (UXP)              manifest.json inside it
//   Blender extension       blender_manifest.toml (zip or folder)
//   Blender legacy add-on   bl_info in __init__.py (zip or folder) or in the .py
//   .jsx / .jsfl            the file name; a version only if the script states one
//
// A folder that is none of these but holds exactly one of them (a release
// folder with one .zxp, a repository with one panel folder) works too. The
// result is built into an ordinary package folder with a zeploy.json, so the
// rest of zeploy never sees the difference.

import { copyFile, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { PlanError } from "./actions.ts";
import { CEP_HOSTS, type AppId } from "./env.ts";
import { inspectBlenderSource } from "./handlers/blender.ts";
import { readCepManifest } from "./handlers/cep.ts";
import { isSafeRelativePath, MANIFEST_FILE, type Component, type Manifest } from "./manifest.ts";
import { listFiles } from "./package.ts";

export interface InferredPlugin {
  // What the details were read from, for the admin UI ("CSXS/manifest.xml").
  from: string;
  // Stays the same across versions ("cep:com.colosave.panel"), so a later
  // version is recognised as the same plugin whatever id it was added under.
  key: string;
  id: string;
  name: string;
  // Null when the plugin does not state one; the admin has to enter it.
  version: string | null;
  // zxp only: the name UnifiedPluginInstallerAgent lists it under.
  extensionName?: string;
  // Its source is where buildInferredPackage puts it in the package.
  component: Component;
  apps: AppId[];
  // How the source gets into the package.
  input: { path: string; as: "copy" | "zip-folder" } | { path: string; as: "extract"; prefix: string };
}

export class InferError extends Error {
  override name = "InferError";
}

// "1.2" -> "1.2.0", "v2.0.1.7" -> "2.0.1". Null when there is no number.
export function normalizeVersion(raw: string | null | undefined): string | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw ?? "");
  return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : null;
}

// A valid manifest id from any name: "Auto Rig Pro" -> "auto-rig-pro".
export function slugId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  return slug || "plugin";
}

const fileStem = (path: string) => basename(path, extname(path));
const isDir = async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false;
const isFile = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

// ---- readers ----------------------------------------------------------------

interface CepXml {
  bundleId: string;
  version: string | null;
  name: string;
  apps: AppId[];
}

function parseCepXml(xml: string, where: string): CepXml {
  const bundleId = /ExtensionBundleId\s*=\s*"([^"]+)"/.exec(xml)?.[1];
  if (!bundleId) throw new InferError(`no ExtensionBundleId in ${where}`);
  const bundleName = /ExtensionBundleName\s*=\s*"([^"]+)"/.exec(xml)?.[1];
  const menu = /<Menu(?:\s[^>]*)?>\s*([^<]+?)\s*<\/Menu>/.exec(xml)?.[1];
  const apps = new Set<AppId>();
  for (const m of xml.matchAll(/<Host\s+[^>]*Name\s*=\s*"([A-Z]+)"/g)) {
    const app = m[1] ? CEP_HOSTS[m[1]] : undefined;
    if (app) apps.add(app);
  }
  return {
    bundleId,
    version: /ExtensionBundleVersion\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null,
    name: bundleName ?? menu ?? bundleId.split(".").at(-1) ?? bundleId,
    apps: [...apps],
  };
}

// The name and version in a legacy add-on's bl_info dictionary.
export function parseBlInfo(source: string): { name: string | null; version: string | null } {
  const block = /bl_info\s*=\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
  const name = /["']name["']\s*:\s*["']([^"']+)["']/.exec(block)?.[1] ?? null;
  const tuple = /["']version["']\s*:\s*\(([^)]*)\)/.exec(block)?.[1];
  const version = tuple ? normalizeVersion(tuple.split(",").map((s) => s.trim()).filter(Boolean).join(".")) : null;
  return { name, version };
}

// A version a script states near its top: "@version 1.2.0" or
// `var SCRIPT_VERSION = "1.2"`. Scripts without one leave it to the admin.
export function scriptVersion(source: string): string | null {
  const head = source.slice(0, 8192);
  const m =
    /@version\s+v?(\d+(?:\.\d+){0,2})/i.exec(head) ??
    /version\s*[:=]\s*["']v?(\d+(?:\.\d+){0,2})["']/i.exec(head);
  return normalizeVersion(m?.[1]);
}

function tomlString(text: string, key: string): string | null {
  const head = text.split(/^\s*\[/m)[0] ?? "";
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(head)?.[1] ?? null;
}

function unzipSome(buf: Uint8Array, want: (name: string) => boolean, what: string): Record<string, Uint8Array> {
  try {
    return unzipSync(buf, { filter: (f) => want(f.name.replace(/\\/g, "/")) });
  } catch (err) {
    throw new InferError(`${what} is not a readable zip: ${(err as Error).message}`);
  }
}

const text = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : "");

// ---- one plugin -------------------------------------------------------------

async function fromCepFolder(dir: string): Promise<InferredPlugin> {
  const xml = await readFile(join(dir, "CSXS", "manifest.xml"), "utf8");
  const cep = parseCepXml(xml, join(dir, "CSXS", "manifest.xml"));
  return {
    from: "CSXS/manifest.xml",
    key: `cep:${cep.bundleId.toLowerCase()}`,
    id: slugId(cep.bundleId),
    name: cep.name,
    version: normalizeVersion(cep.version),
    component: { type: "cep", source: basename(dir), playerDebugMode: true },
    apps: cep.apps,
    input: { path: dir, as: "copy" },
  };
}

async function fromZxp(file: string): Promise<InferredPlugin> {
  const buf = await readFile(file);
  const source = basename(file);
  if (/\.ccx$/i.test(file)) {
    const entries = unzipSome(buf, (n) => n === "manifest.json", source);
    let manifest: { id?: unknown; name?: unknown; version?: unknown; host?: unknown };
    try {
      manifest = JSON.parse(text(entries["manifest.json"]));
    } catch {
      throw new InferError(`${source} has no readable manifest.json`);
    }
    const id = typeof manifest.id === "string" ? manifest.id : fileStem(file);
    const name = typeof manifest.name === "string" ? manifest.name : fileStem(file);
    const hosts = [manifest.host].flat().map((h) => String((h as { app?: unknown } | undefined)?.app ?? "").toUpperCase());
    const apps = new Set<AppId>();
    if (hosts.some((h) => h === "PPRO" || h === "PREMIEREPRO")) apps.add("premiere");
    if (hosts.some((h) => h === "AEFT" || h === "AFTEREFFECTS")) apps.add("aftereffects");
    return {
      from: "manifest.json",
      key: `zxp:${id.toLowerCase()}`,
      id: slugId(id),
      name,
      version: normalizeVersion(typeof manifest.version === "string" ? manifest.version : null),
      extensionName: name,
      component: { type: "zxp", source, extensionName: name },
      apps: [...apps],
      input: { path: file, as: "copy" },
    };
  }
  const entries = unzipSome(buf, (n) => n === "CSXS/manifest.xml", source);
  const cep = parseCepXml(text(entries["CSXS/manifest.xml"]), `${source}/CSXS/manifest.xml`);
  const extensionName = cep.name === cep.bundleId.split(".").at(-1) ? cep.bundleId : cep.name;
  return {
    from: "CSXS/manifest.xml",
    key: `zxp:${cep.bundleId.toLowerCase()}`,
    id: slugId(cep.bundleId),
    name: cep.name,
    version: normalizeVersion(cep.version),
    extensionName,
    component: { type: "zxp", source, extensionName },
    apps: cep.apps,
    input: { path: file, as: "copy" },
  };
}

async function fromBlenderZip(file: string): Promise<InferredPlugin> {
  const info = await inspectBlenderSource(file).catch((err: Error) => {
    throw new InferError(err.message);
  });
  const source = basename(file);
  let name: string | null = null;
  let version = normalizeVersion(info.version);
  const entries = unzipSome(
    await readFile(file),
    (n) => /(^|\/)blender_manifest\.toml$/.test(n) || n === `${info.module}/__init__.py`,
    source,
  );
  if (info.kind === "extension") {
    const toml = Object.entries(entries).find(([n]) => n.endsWith("blender_manifest.toml"))?.[1];
    name = tomlString(text(toml), "name");
  } else {
    const bl = parseBlInfo(text(entries[`${info.module}/__init__.py`]));
    name = bl.name;
    version ??= bl.version;
  }
  return {
    from: info.kind === "extension" ? "blender_manifest.toml" : "bl_info",
    key: `blender:${info.module.toLowerCase()}`,
    id: slugId(info.module),
    name: name ?? info.module,
    version,
    component: { type: "blender", source },
    apps: ["blender"],
    input: { path: file, as: "copy" },
  };
}

async function fromBlenderFolder(dir: string): Promise<InferredPlugin> {
  const toml = await readFile(join(dir, "blender_manifest.toml"), "utf8").catch(() => null);
  const folder = basename(dir);
  if (toml !== null) {
    const id = tomlString(toml, "id");
    if (!id) throw new InferError(`blender_manifest.toml in ${dir} has no id`);
    return {
      from: "blender_manifest.toml",
      key: `blender:${id.toLowerCase()}`,
      id: slugId(id),
      name: tomlString(toml, "name") ?? id,
      version: normalizeVersion(tomlString(toml, "version")),
      component: { type: "blender", source: `${folder}.zip` },
      apps: ["blender"],
      input: { path: dir, as: "zip-folder" },
    };
  }
  const bl = parseBlInfo(await readFile(join(dir, "__init__.py"), "utf8"));
  return {
    from: "bl_info",
    key: `blender:${folder.toLowerCase()}`,
    id: slugId(folder),
    name: bl.name ?? folder,
    version: bl.version,
    component: { type: "blender", source: `${folder}.zip` },
    apps: ["blender"],
    input: { path: dir, as: "zip-folder" },
  };
}

async function fromScript(file: string): Promise<InferredPlugin> {
  const source = basename(file);
  const ext = extname(file).toLowerCase();
  // .jsxbin is compiled: nothing to read in it.
  const body = ext === ".jsxbin" ? "" : await readFile(file, "utf8");
  if (ext === ".py") {
    const bl = parseBlInfo(body);
    return {
      from: "bl_info",
      key: `blender:${fileStem(file).toLowerCase()}`,
      id: slugId(fileStem(file)),
      name: bl.name ?? fileStem(file),
      version: bl.version,
      component: { type: "blender", source },
      apps: ["blender"],
      input: { path: file, as: "copy" },
    };
  }
  const version = scriptVersion(body);
  const from = version ? "the script" : "the file name";
  if (ext === ".jsfl") {
    return {
      from,
      key: `jsfl:${source.toLowerCase()}`,
      id: slugId(fileStem(file)),
      name: fileStem(file),
      version,
      component: { type: "jsfl", source, folder: "Commands" },
      apps: ["animate"],
      input: { path: file, as: "copy" },
    };
  }
  // A ScriptUI panel builds its UI in the Panel it is docked into.
  const folder = ext === ".jsxbin" || /instanceof\s+Panel\b/.test(body) ? "ScriptUI Panels" : "Scripts";
  return {
    from,
    key: `ae-script:${source.toLowerCase()}`,
    id: slugId(fileStem(file)),
    name: fileStem(file),
    version,
    component: { type: "ae-script", source, folder },
    apps: ["aftereffects"],
    input: { path: file, as: "copy" },
  };
}

// A zip without zeploy.json: a Blender extension or add-on, or a zipped CEP panel.
async function fromZip(file: string): Promise<InferredPlugin> {
  const names: string[] = [];
  unzipSome(await readFile(file), (n) => (names.push(n), false), basename(file));
  const cep = names
    .filter((n) => /^(?:[^/]+\/)?CSXS\/manifest\.xml$/.test(n))
    .sort((a, b) => a.length - b.length)[0];
  if (!cep) return fromBlenderZip(file);

  const prefix = cep.slice(0, -"CSXS/manifest.xml".length);
  const entries = unzipSome(await readFile(file), (n) => n === cep, basename(file));
  const info = parseCepXml(text(entries[cep]), `${basename(file)}/${cep}`);
  return {
    from: "CSXS/manifest.xml",
    key: `cep:${info.bundleId.toLowerCase()}`,
    id: slugId(info.bundleId),
    name: info.name,
    version: normalizeVersion(info.version),
    component: { type: "cep", source: prefix ? prefix.slice(0, -1) : fileStem(file), playerDebugMode: true },
    apps: info.apps,
    input: { path: file, as: "extract", prefix },
  };
}

const SCRIPT = /\.(jsx|jsxbin|jsfl|py)$/i;

// The plugin `path` is, or null if it is not one zeploy recognises.
async function asPlugin(path: string): Promise<InferredPlugin | null> {
  if (await isDir(path)) {
    if (await isFile(join(path, "CSXS", "manifest.xml"))) return fromCepFolder(path);
    if (await isFile(join(path, "blender_manifest.toml"))) return fromBlenderFolder(path);
    const init = await readFile(join(path, "__init__.py"), "utf8").catch(() => "");
    if (/\bbl_info\s*=/.test(init)) return fromBlenderFolder(path);
    return null;
  }
  if (/\.(zxp|ccx)$/i.test(path)) return fromZxp(path);
  if (/\.zip$/i.test(path)) return fromZip(path);
  if (/\.py$/i.test(path)) {
    // Any .py could sit in a folder; only an add-on declares bl_info.
    return /\bbl_info\s*=/.test(await readFile(path, "utf8")) ? fromScript(path) : null;
  }
  if (SCRIPT.test(path)) return fromScript(path);
  return null;
}

// A folder with zeploy.json, or a zip with it at the root: an ordinary package.
export async function hasManifest(path: string): Promise<boolean> {
  if (await isDir(path)) return isFile(join(path, MANIFEST_FILE));
  if (!/\.zip$/i.test(path) || !(await isFile(path))) return false;
  let found = false;
  unzipSome(await readFile(path), (n) => (n === MANIFEST_FILE && (found = true), false), basename(path));
  return found;
}

// Works out the package for a plugin folder or file that has no zeploy.json.
export async function inferPlugin(path: string): Promise<InferredPlugin> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new InferError(`not found: ${path}`);
  const direct = await asPlugin(path);
  if (direct) return direct;
  if (!info.isDirectory()) {
    throw new InferError(
      `${basename(path)} is not a plugin zeploy recognises: expected a CEP panel folder, .zxp, .ccx, ` +
        `Blender extension or add-on, .jsx, .jsxbin or .jsfl`,
    );
  }

  // A folder holding one plugin, one level down.
  const found: InferredPlugin[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const plugin = await asPlugin(join(path, entry.name)).catch(() => null);
    if (plugin) found.push(plugin);
  }
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new InferError(`${MANIFEST_FILE} not found in ${path}, and it holds no plugin zeploy recognises`);
  }
  throw new InferError(
    `${path} holds ${found.length} plugins (${found.map((p) => p.component.source).join(", ")}). ` +
      `Pick one of them, or write a ${MANIFEST_FILE} that lists them as components of one package.`,
  );
}

// Writes `dir` as a package folder: zeploy.json plus the plugin under its
// component's source, ready for packPackage.
//
// Every file written gets the time of the file it came from. packPackage
// puts file times into the zip, so the same plugin always packs to the same
// bytes, and adding it twice is "already added", not a conflict.
export async function buildInferredPackage(plugin: InferredPlugin, manifest: Manifest, dir: string): Promise<void> {
  const target = join(dir, plugin.component.source);
  const { input } = plugin;
  const inputTime = (await stat(input.path)).mtime;
  const put = async (file: string, data: Uint8Array | string, time: Date) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    await utimes(file, time, time);
  };
  await put(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", inputTime);

  if (input.as === "copy" && (await isDir(input.path))) {
    for (const rel of await listFiles(input.path)) {
      const from = join(input.path, rel);
      await mkdir(dirname(join(target, rel)), { recursive: true });
      await copyFile(from, join(target, rel));
      const time = (await stat(from)).mtime;
      await utimes(join(target, rel), time, time);
    }
  } else if (input.as === "copy") {
    await copyFile(input.path, target);
    await utimes(target, inputTime, inputTime);
  } else if (input.as === "zip-folder") {
    // One top-level folder, as Blender expects of an add-on zip.
    const zip: Zippable = {};
    const top = basename(input.path);
    for (const rel of await listFiles(input.path)) {
      if (/(^|[\\/])__pycache__([\\/]|$)/.test(rel)) continue;
      const from = join(input.path, rel);
      zip[`${top}/${rel.replace(/\\/g, "/")}`] = [await readFile(from), { mtime: (await stat(from)).mtime }];
    }
    await put(target, zipSync(zip, { level: 6 }), inputTime);
  } else if (input.as === "extract") {
    const { prefix } = input;
    const entries = unzipSome(await readFile(input.path), (n) => n.startsWith(prefix) && !n.endsWith("/"), input.path);
    for (const [name, data] of Object.entries(entries)) {
      const rel = name.replace(/\\/g, "/").slice(prefix.length);
      if (!isSafeRelativePath(rel)) throw new InferError(`unsafe path in archive: ${name}`);
      await put(join(target, rel), data, inputTime);
    }
  }
}

// The keys (see InferredPlugin.key) of a package that has a zeploy.json, so
// a later version added without one is recognised as the same plugin.
export async function packageKeys(root: string, manifest: Manifest): Promise<string[]> {
  const keys: string[] = [];
  for (const c of manifest.components) {
    const full = join(root, c.source);
    try {
      if (c.type === "cep") keys.push(`cep:${(await readCepManifest(full)).bundleId.toLowerCase()}`);
      else if (c.type === "zxp") keys.push((await fromZxp(full)).key);
      else if (c.type === "blender") keys.push(`blender:${(await inspectBlenderSource(full)).module.toLowerCase()}`);
      else keys.push(`${c.type}:${basename(c.source).toLowerCase()}`);
    } catch (err) {
      if (!(err instanceof InferError || err instanceof PlanError)) throw err;
    }
  }
  return keys;
}
