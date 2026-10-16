// Adding packages to the admin server's repository.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { openPackage, packPackage, readCepManifest, type AppId, type Manifest } from "../../core/src/index.ts";
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
  status: "new" | "same" | "conflict";
}

interface Staged {
  zipPath: string;
  manifest: Manifest;
  sha256: string;
  apps: AppId[];
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
// code an agent uses, so a package that passes here also installs.
async function stagePackage(store: Store, sourcePath: string, work: string): Promise<Staged> {
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
    return { zipPath, manifest: pkg.manifest, sha256: pkg.archive?.sha256 ?? "", apps: await appsOf(pkg.root, pkg.manifest) };
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

export async function inspectPackage(store: Store, sourcePath: string): Promise<PackagePreview> {
  const work = workDir(store);
  try {
    const staged = await stagePackage(store, sourcePath, work);
    const { manifest } = staged;
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      components: manifest.components.map((c) => ({ type: c.type, source: c.source })),
      apps: staged.apps,
      status: statusOf(store, staged),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Accepts a package folder (packed here) or a .zip. A version can be added
// once; changed content needs a new version number, otherwise PCs that
// already have "1.2.0" would silently differ.
export async function importPackage(
  store: Store,
  sourcePath: string,
): Promise<{ record: PackageRecord; apps: AppId[] }> {
  const work = workDir(store);
  try {
    const staged = await stagePackage(store, sourcePath, work);
    const { manifest, sha256, apps, zipPath } = staged;
    const status = statusOf(store, staged);
    if (status === "conflict") {
      throw new HttpError(
        409,
        `${manifest.id} ${manifest.version} is already in the repository with different content; ` +
          `raise "version" in zeploy.json`,
      );
    }
    if (status === "same") {
      const existing = store.data.packages.find((p) => p.id === manifest.id && p.version === manifest.version)!;
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
    };
    store.data.packages.push(record);
    store.save();
    return { record, apps };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
