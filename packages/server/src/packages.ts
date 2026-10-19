// Adding packages to the admin server's repository.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildInferredPackage,
  hasManifest,
  inferPlugin,
  manifestSchema,
  openPackage,
  packageKeys,
  packPackage,
  readCepManifest,
  type AppId,
  type InferredPlugin,
  type Manifest,
} from "../../core/src/index.ts";
import type { PackageRecord, Store } from "./store.ts";

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function packagesDir(store: Store): string {
  return join(store.dir, "packages");
}

// What adding a package would do, worked out without storing anything.
export interface PackagePreview {
  id: string;
  name: string;
  version: string;
  components: { type: string; source: string }[];
  // Apps the package installs into, so the UI can offer the PCs that have them.
  apps: AppId[];
  // "same": this exact version is already in the repository (adding is a no-op).
  // "conflict": the version is there with other files; it needs a new number.
  // "incomplete": read without zeploy.json, and a detail is missing (detected.missing).
  status: "new" | "same" | "conflict" | "incomplete";
  // Present when the source has no zeploy.json and zeploy read the details
  // from the plugin's own files.
  detected?: {
    from: string;
    missing: "version"[];
    // zxp only, editable like name and version.
    extensionName?: string;
    // The package this is another version of, by plugin identity.
    updates: { id: string; name: string; version: string } | null;
  };
}

// Details the admin typed over what was read from a plugin without zeploy.json.
export interface Overrides {
  id?: string;
  name?: string;
  version?: string;
  extensionName?: string;
}

interface Detection {
  plugin: InferredPlugin;
  id: string;
  name: string;
  version: string | null;
  extensionName?: string;
  updates: PackageRecord | null;
}

interface Staged {
  zipPath: string;
  manifest: Manifest;
  sha256: string;
  apps: AppId[];
  // See InferredPlugin.key.
  keys: string[];
  detection?: Detection;
}

// Reads a plugin that has no zeploy.json. A later version of a plugin
// already in the repository keeps that package's id and name, so it lands in
// the same column.
async function detect(store: Store, sourcePath: string, overrides: Overrides): Promise<Detection> {
  const plugin = await inferPlugin(sourcePath).catch((err: Error) => {
    throw new HttpError(400, err.message);
  });
  const sameName = (p: PackageRecord) => p.name.toLowerCase() === plugin.name.toLowerCase();
  const known =
    store.data.packages.find((p) => p.keys?.includes(plugin.key)) ??
    store.data.packages.find((p) => !p.keys && (p.id === plugin.id || sameName(p)));
  const id = overrides.id?.trim() || known?.id || plugin.id;
  const updates = latestPackage(store, id) ?? null;
  return {
    plugin,
    id,
    name: overrides.name?.trim() || updates?.name || plugin.name,
    version: overrides.version?.trim() || plugin.version,
    extensionName: plugin.component.type === "zxp" ? overrides.extensionName?.trim() || plugin.extensionName : undefined,
    updates,
  };
}

function manifestOf(d: Detection): Manifest {
  const component =
    d.plugin.component.type === "zxp" ? { ...d.plugin.component, extensionName: d.extensionName } : d.plugin.component;
  const result = manifestSchema.safeParse({ schemaVersion: 1, id: d.id, name: d.name, version: d.version, components: [component] });
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = issue.path.at(-1) === "extensionName" ? "extension name" : String(issue.path.at(-1) ?? "details");
    throw new HttpError(400, `${field}: ${issue.message}`);
  }
  return result.data;
}

function detectedOf(d: Detection): NonNullable<PackagePreview["detected"]> {
  return {
    from: d.plugin.from,
    missing: d.version ? [] : ["version"],
    extensionName: d.extensionName,
    updates: d.updates ? { id: d.updates.id, name: d.updates.name, version: d.updates.version } : null,
  };
}

async function appsOf(root: string, manifest: Manifest): Promise<AppId[]> {
  const apps = new Set<AppId>();
  for (const c of manifest.components) {
    if (c.type === "cep") for (const host of (await readCepManifest(join(root, c.source))).hosts) apps.add(host);
    else if (c.type === "ae-script") apps.add("aftereffects");
    else if (c.type === "jsfl") apps.add("animate");
    else if (c.type === "blender") apps.add("blender");
  }
  return [...apps];
}

// Packs a folder (into `work`) or takes a .zip, then opens it with the same
// code an agent uses, so a package that passes here also installs. A plugin
// without zeploy.json is built into a package folder first.
async function stagePackage(
  store: Store,
  sourcePath: string,
  work: string,
  overrides: Overrides,
  detection?: Detection,
): Promise<Staged> {
  if (detection || !(await hasManifest(sourcePath))) {
    const d = detection ?? (await detect(store, sourcePath, overrides));
    if (!d.version) throw new HttpError(400, `enter a version: ${d.plugin.from} does not state one`);
    const dir = join(work, "pkg");
    await buildInferredPackage(d.plugin, manifestOf(d), dir);
    return { ...(await stageManifested(store, dir, work)), keys: [d.plugin.key], detection: d };
  }
  return stageManifested(store, sourcePath, work);
}

async function stageManifested(store: Store, sourcePath: string, work: string): Promise<Staged> {
  const info = await stat(sourcePath).catch(() => null);
  if (!info) throw new HttpError(400, `not found: ${sourcePath}`);
  let zipPath = sourcePath;
  if (info.isDirectory()) {
    zipPath = (await packPackage(sourcePath, work).catch((err: Error) => {
      throw new HttpError(400, err.message);
    })).path;
  } else if (!/\.zip$/i.test(sourcePath)) {
    throw new HttpError(400, "expected a package folder or a .zip file");
  }
  const pkg = await openPackage(zipPath, { stagingRoot: join(store.dir, "staging") }).catch((err: Error) => {
    throw new HttpError(400, err.message);
  });
  try {
    return {
      zipPath,
      manifest: pkg.manifest,
      sha256: pkg.archive?.sha256 ?? "",
      apps: await appsOf(pkg.root, pkg.manifest),
      keys: await packageKeys(pkg.root, pkg.manifest),
    };
  } finally {
    await pkg.close();
  }
}

function statusOf(store: Store, staged: Staged): PackagePreview["status"] {
  const existing = store.data.packages.find((p) => p.id === staged.manifest.id && p.version === staged.manifest.version);
  if (!existing) return "new";
  return existing.sha256 === staged.sha256 ? "same" : "conflict";
}

function workDir(store: Store): string {
  return join(store.dir, "staging", `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

export async function inspectPackage(store: Store, sourcePath: string, overrides: Overrides = {}): Promise<PackagePreview> {
  const work = workDir(store);
  try {
    let detection: Detection | undefined;
    if (!(await hasManifest(sourcePath))) {
      detection = await detect(store, sourcePath, overrides);
      if (!detection.version) {
        return {
          id: detection.id,
          name: detection.name,
          version: "",
          components: [{ type: detection.plugin.component.type, source: detection.plugin.component.source }],
          apps: detection.plugin.apps,
          status: "incomplete",
          detected: detectedOf(detection),
        };
      }
    }
    const staged = await stagePackage(store, sourcePath, work, overrides, detection);
    const { manifest } = staged;
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      components: manifest.components.map((c) => ({ type: c.type, source: c.source })),
      apps: staged.apps,
      status: statusOf(store, staged),
      detected: staged.detection && detectedOf(staged.detection),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Accepts a package folder (packed here), a .zip, or a plugin without
// zeploy.json. A version can be added once; changed content needs a new
// version number, otherwise PCs that already have "1.2.0" would silently differ.
export async function importPackage(
  store: Store,
  sourcePath: string,
  overrides: Overrides = {},
  // Remembered so the package can be read again for a newer version; unset for uploads.
  source?: string,
): Promise<{ record: PackageRecord; apps: AppId[] }> {
  const work = workDir(store);
  try {
    const staged = await stagePackage(store, sourcePath, work, overrides);
    const { manifest, sha256, apps, zipPath } = staged;
    const status = statusOf(store, staged);
    if (status === "conflict") {
      const where = staged.detection ? `the version (in ${staged.detection.plugin.from} or here)` : `"version" in zeploy.json`;
      throw new HttpError(
        409,
        `${manifest.id} ${manifest.version} is already in the repository with different content; raise ${where}`,
      );
    }
    if (status === "same") {
      const existing = store.data.packages.find((p) => p.id === manifest.id && p.version === manifest.version)!;
      if (source) existing.source = source;
      existing.keys ??= staged.keys;
      store.save();
      return { record: existing, apps };
    }

    const file = `${manifest.id}-${manifest.version}.zip`;
    await mkdir(packagesDir(store), { recursive: true });
    await copyFile(zipPath, join(packagesDir(store), file));
    const record: PackageRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      sha256,
      size: (await stat(zipPath)).size,
      file,
      addedAt: new Date().toISOString(),
      components: manifest.components.map((c) => ({ type: c.type, source: c.source })),
      keys: staged.keys,
      source,
    };
    store.data.packages.push(record);
    store.save();
    return { record, apps };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Packages added before zeploy recorded plugin identities get them from
// their stored zip, so PCs that already have such a plugin show it.
export async function backfillKeys(store: Store): Promise<boolean> {
  let changed = false;
  for (const record of store.data.packages.filter((p) => !p.keys)) {
    const pkg = await openPackage(join(packagesDir(store), record.file), { stagingRoot: join(store.dir, "staging") }).catch(
      () => null,
    );
    if (!pkg) continue;
    try {
      record.keys = await packageKeys(pkg.root, pkg.manifest);
      changed = true;
    } finally {
      await pkg.close();
    }
  }
  if (changed) store.save();
  return changed;
}

export async function removePackage(store: Store, id: string, version: string): Promise<void> {
  const i = store.data.packages.findIndex((p) => p.id === id && p.version === version);
  if (i < 0) throw new HttpError(404, `${id} ${version} is not in the repository`);
  const [record] = store.data.packages.splice(i, 1);
  if (record) await rm(join(packagesDir(store), record.file), { force: true });
  store.save();
}

// "1.10.0" > "1.9.0"; a pre-release sorts before its release.
export function compareSemver(a: string, b: string): number {
  const [ca = "", pa] = a.split(/[-+]/, 2);
  const [cb = "", pb] = b.split(/[-+]/, 2);
  const na = ca.split(".").map(Number);
  const nb = cb.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return (pa ?? "").localeCompare(pb ?? "");
}

export function latestPackage(store: Store, id: string): PackageRecord | undefined {
  return store.data.packages
    .filter((p) => p.id === id)
    .sort((a, b) => compareSemver(a.version, b.version))
    .at(-1);
}
