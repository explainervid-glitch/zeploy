// Adding packages to the admin server's repository.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { openPackage, packPackage } from "../../core/src/index.ts";
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

// Accepts a package folder (packed here) or a .zip. The zip is opened with the
// same code an agent uses, so a package that imports cleanly also installs.
// A version can be added once; changed content needs a new version number,
// otherwise PCs that already have "1.2.0" would silently differ.
export async function importPackage(store: Store, sourcePath: string): Promise<PackageRecord> {
  const info = await stat(sourcePath).catch(() => null);
  if (!info) throw new HttpError(400, `not found: ${sourcePath}`);

  const work = join(store.dir, "staging", `import-${Date.now()}`);
  try {
    let zipPath = sourcePath;
    if (info.isDirectory()) {
      zipPath = (await packPackage(sourcePath, work)).path;
    } else if (!/\.zip$/i.test(sourcePath)) {
      throw new HttpError(400, "expected a package folder or a .zip file");
    }

    const pkg = await openPackage(zipPath, { stagingRoot: join(store.dir, "staging") }).catch((err: Error) => {
      throw new HttpError(400, err.message);
    });
    const { manifest } = pkg;
    const sha256 = pkg.archive?.sha256 ?? "";
    await pkg.close();

    const existing = store.data.packages.find((p) => p.id === manifest.id && p.version === manifest.version);
    if (existing) {
      if (existing.sha256 === sha256) return existing;
      throw new HttpError(
        409,
        `${manifest.id} ${manifest.version} is already in the repository with different content; ` +
          `raise "version" in zdeploy.json`,
      );
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
    return record;
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
