// Blender extensions (4.2+) and legacy add-ons.
//
// Both are installed by running each compatible blender.exe in the
// background, so Blender itself puts the files in the right user folder and
// records the add-on as enabled in that version's preferences. Every Blender
// version keeps its own preferences, so each one gets its own run.
//
// Developer links need care here. Blender replaces an existing add-on with
// shutil.rmtree, and on Python 3.11 (Blender 4.2) rmtree walks into a
// directory junction and deletes what it points at. So a link in the way is
// either refused, or removed as a link by zdeploy before Blender runs.

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { unzipSync } from "fflate";
import {
  emptyResult,
  PlanError,
  type Action,
  type HandlerResult,
  type PlanContext,
  type ReceiptItem,
} from "../actions.ts";
import { APP_PROCESSES, compareVersions, type BlenderInstall, type Environment } from "../env.ts";
import { linkTarget } from "../fsutil.ts";
import type { BlenderComponent } from "../manifest.ts";

const MIN_EXTENSION_BLENDER = "4.2";
const BLENDER_TIMEOUT_MS = 5 * 60_000;

// Where a Blender version keeps user add-ons and extensions, following the
// same overrides Blender does: BLENDER_USER_* variables, then a "portable"
// folder beside blender.exe, then %APPDATA%.
export async function blenderUserDirs(
  b: BlenderInstall,
  env: Environment,
  vars: NodeJS.ProcessEnv = process.env,
): Promise<{ addons: string; extensions: string }> {
  const portable = join(b.dir, "portable");
  const resources =
    vars["BLENDER_USER_RESOURCES"] ??
    ((await stat(portable).catch(() => null))?.isDirectory()
      ? portable
      : join(env.paths.appData, "Blender Foundation", "Blender", b.version));
  return {
    addons: join(vars["BLENDER_USER_SCRIPTS"] ?? join(resources, "scripts"), "addons"),
    extensions: vars["BLENDER_USER_EXTENSIONS"] ?? join(resources, "extensions"),
  };
}

export interface BlenderSourceInfo {
  kind: "extension" | "addon";
  // Extension id, or add-on module name.
  module: string;
  version: string | null;
  minBlender: string | null;
  // Exclusive, as blender_version_max is in blender_manifest.toml.
  maxBlenderExclusive: string | null;
}

// Top-level string keys of a TOML file, i.e. those before the first [table].
function tomlTopLevel(text: string): Map<string, string> {
  const head = text.split(/^\s*\[/m)[0] ?? "";
  const out = new Map<string, string>();
  for (const m of head.matchAll(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/gm)) {
    if (m[1] && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

export async function inspectBlenderSource(path: string): Promise<BlenderSourceInfo> {
  if (/\.py$/i.test(path)) {
    return {
      kind: "addon",
      module: basename(path, extname(path)),
      version: null,
      minBlender: null,
      maxBlenderExclusive: null,
    };
  }

  // Compress-Archive in Windows PowerShell 5.1 writes "\" into entry names.
  const norm = (name: string) => name.replace(/\\/g, "/");
  const names: string[] = [];
  const isManifest = (name: string) => /(^|\/)blender_manifest\.toml$/.test(name) && name.split("/").length <= 2;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await readFile(path), {
      filter: (f) => {
        names.push(norm(f.name));
        return isManifest(norm(f.name));
      },
    });
  } catch (err) {
    throw new PlanError(`${basename(path)} is not a readable zip: ${(err as Error).message}`);
  }

  const manifestName = Object.keys(entries).sort((a, b) => a.length - b.length)[0];
  if (manifestName) {
    const toml = tomlTopLevel(new TextDecoder().decode(entries[manifestName]));
    const id = toml.get("id");
    if (!id) throw new PlanError(`${basename(path)}: blender_manifest.toml has no id`);
    return {
      kind: "extension",
      module: id,
      version: toml.get("version") ?? null,
      minBlender: toml.get("blender_version_min") ?? null,
      maxBlenderExclusive: toml.get("blender_version_max") ?? null,
    };
  }

  // Legacy add-on: one top-level folder with __init__.py, or one .py file.
  const top = new Set(names.map((n) => n.split("/")[0]).filter((n): n is string => !!n && n !== "__MACOSX"));
  const [only] = [...top];
  if (top.size === 1 && only) {
    if (names.includes(`${only}/__init__.py`)) {
      return { kind: "addon", module: only, version: null, minBlender: null, maxBlenderExclusive: null };
    }
    if (/\.py$/i.test(only)) {
      return {
        kind: "addon",
        module: only.slice(0, -3),
        version: null,
        minBlender: null,
        maxBlenderExclusive: null,
      };
    }
  }
  throw new PlanError(
    `${basename(path)} is neither a Blender extension (no blender_manifest.toml) ` +
      `nor a legacy add-on (one folder with __init__.py)`,
  );
}

function majorMinor(v: string): string {
  return v.split(".").slice(0, 2).join(".");
}

// Python string literal. JSON escaping is valid Python for any string.
function py(s: string): string {
  return JSON.stringify(s);
}

// Shared by the scripts below: the add-on's paths in the user add-ons folder,
// and a link test that also sees junctions on Python 3.11, which has no
// os.path.isjunction (0xA0000003 is IO_REPARSE_TAG_MOUNT_POINT).
function addonPathsPrelude(module: string): string[] {
  return [
    "import bpy, addon_utils, os, shutil, sys",
    `m = ${py(module)}`,
    "root = bpy.utils.user_resource('SCRIPTS', path='addons')",
    "paths = [os.path.join(root, m), os.path.join(root, m + '.py')]",
    "def is_link(p):",
    "    try: st = os.lstat(p)",
    "    except OSError: return False",
    "    return os.path.islink(p) or getattr(st, 'st_reparse_tag', 0) == 0xA0000003",
  ];
}

function addonInstallScript(file: string, module: string): string {
  return [
    ...addonPathsPrelude(module),
    "for p in paths:",
    "    if is_link(p):",
    "        print('zdeploy: refusing to replace developer link ' + p); sys.exit(3)",
    `r = bpy.ops.preferences.addon_install(filepath=${py(file)}, overwrite=True)`,
    "if 'FINISHED' not in r: sys.exit(1)",
    "r = bpy.ops.preferences.addon_enable(module=m)",
    "if 'FINISHED' not in r: sys.exit(1)",
    "bpy.ops.wm.save_userpref()",
  ].join("\n");
}

// bpy.ops.preferences.addon_remove needs a UI area and fails in background
// mode, so the add-on is disabled through addon_utils and its files removed
// directly. A developer link is disabled but never deleted.
function addonRemoveScript(module: string): string {
  return [
    ...addonPathsPrelude(module),
    "addon_utils.disable(m, default_set=True)",
    "for p in paths:",
    "    if is_link(p): print('zdeploy: leaving developer link ' + p)",
    "    elif os.path.isdir(p): shutil.rmtree(p)",
    "    elif os.path.isfile(p): os.remove(p)",
    "bpy.ops.wm.save_userpref()",
  ].join("\n");
}

export async function planBlender(c: BlenderComponent, ctx: PlanContext): Promise<HandlerResult> {
  const { env, options } = ctx;
  const source = join(ctx.root, c.source);
  const info = await inspectBlenderSource(source);
  const kind = c.kind ?? info.kind;
  const module = c.module ?? info.module;

  let min = c.minBlender ?? info.minBlender;
  if (kind === "extension" && (!min || compareVersions(majorMinor(min), MIN_EXTENSION_BLENDER) < 0)) {
    min = MIN_EXTENSION_BLENDER;
  }

  const fits = (b: BlenderInstall) =>
    (!min || compareVersions(b.version, majorMinor(min)) >= 0) &&
    (!c.maxBlender || compareVersions(b.version, majorMinor(c.maxBlender)) <= 0) &&
    (!info.maxBlenderExclusive || compareVersions(b.version, info.maxBlenderExclusive) < 0);

  const wanted = options.blenderVersions?.length
    ? env.blender.filter((b) => options.blenderVersions?.includes(b.version))
    : env.blender;
  const targets = wanted.filter(fits);
  const skipped = wanted.filter((b) => !fits(b));

  if (targets.length === 0) {
    const found = env.blender.map((b) => b.version).join(", ") || "none";
    throw new PlanError(`no compatible Blender for ${basename(source)} (needs ${min ?? "any"}+, installed: ${found})`);
  }

  const result = emptyResult();
  if (skipped.length > 0) {
    result.warnings.push(
      `${module}: skipped Blender ${skipped.map((b) => b.version).join(", ")} (outside the supported range)`,
    );
  }
  result.actions.push({ kind: "ensureNotRunning", app: "blender", process: APP_PROCESSES.blender });

  for (const b of targets) {
    for (const p of await installPaths(b, env, kind, module)) {
      const target = await linkTarget(p);
      if (!target) continue;
      if (!options.replaceDevLinks) {
        throw new PlanError(
          `${p} is a developer link to ${target}.\n` +
            `  Use --replace-dev-links to replace the link with an installed copy (the linked folder itself is not touched).`,
        );
      }
      result.actions.push({ kind: "removePath", path: p, reason: "developer link replaced by an installed copy" });
    }

    if (kind === "extension") {
      result.actions.push({
        kind: "exec",
        label: `Blender ${b.version}: install extension ${module}`,
        file: b.exe,
        args: ["--command", "extension", "install-file", "--repo", "user_default", "--enable", source],
        timeoutMs: BLENDER_TIMEOUT_MS,
      });
      result.items.push({ kind: "blender-extension", exe: b.exe, version: b.version, id: module });
    } else {
      result.actions.push({
        kind: "exec",
        label: `Blender ${b.version}: install add-on ${module}`,
        file: b.exe,
        args: ["--background", "--python-exit-code", "1", "--python-expr", addonInstallScript(source, module)],
        timeoutMs: BLENDER_TIMEOUT_MS,
      });
      result.items.push({ kind: "blender-addon", exe: b.exe, version: b.version, module });
    }
  }
  return result;
}

// Where Blender will put this add-on or extension for one Blender version.
async function installPaths(
  b: BlenderInstall,
  env: Environment,
  kind: "extension" | "addon",
  module: string,
): Promise<string[]> {
  const dirs = await blenderUserDirs(b, env);
  return kind === "extension"
    ? [join(dirs.extensions, "user_default", module)]
    : [join(dirs.addons, module), join(dirs.addons, `${module}.py`)];
}

export async function blenderRemove(
  item: Extract<ReceiptItem, { kind: "blender-extension" | "blender-addon" }>,
  env: Environment,
): Promise<{ actions: Action[]; warnings: string[] }> {
  if (item.kind === "blender-extension") {
    // Blender deletes the extension folder itself, through rmtree; see the
    // note at the top about junctions.
    const install = { version: item.version, dir: dirname(item.exe), exe: item.exe };
    const [path] = await installPaths(install, env, "extension", item.id);
    const target = path ? await linkTarget(path) : null;
    if (path && target) {
      return { actions: [], warnings: [`left developer link in place: ${path} -> ${target}`] };
    }
    return {
      actions: [
        {
          kind: "exec",
          label: `Blender ${item.version}: remove extension ${item.id}`,
          file: item.exe,
          args: ["--command", "extension", "remove", `user_default.${item.id}`],
          timeoutMs: BLENDER_TIMEOUT_MS,
          // Already gone: nothing to do.
          tolerate: "No installed packages marked",
        },
      ],
      warnings: [],
    };
  }
  return {
    actions: [
      {
        kind: "exec",
        label: `Blender ${item.version}: remove add-on ${item.module}`,
        file: item.exe,
        args: ["--background", "--python-exit-code", "1", "--python-expr", addonRemoveScript(item.module)],
        timeoutMs: BLENDER_TIMEOUT_MS,
      },
    ],
    warnings: [],
  };
}
