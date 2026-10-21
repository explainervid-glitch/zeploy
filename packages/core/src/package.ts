// Opening, extracting and building plugin packages.
//
// On disk a package is either a folder holding zeploy.json, or a .zip of that
// folder with zeploy.json at the archive root. A zip is extracted to a local
// staging folder first, so installs never run from a network share: an
// elevated process cannot see mapped drives such as Z:.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { isSafeRelativePath, MANIFEST_FILE, readManifest, type Manifest } from "./manifest.ts";

export class PackageError extends Error {
  override name = "PackageError";
}

export interface OpenedPackage {
  root: string;
  manifest: Manifest;
  // Present when the package was opened from a zip.
  archive?: { path: string; sha256: string };
  // Removes the staging copy of a zip. A folder package is left alone.
  close(): Promise<void>;
}

export interface OpenOptions {
  // Where zips are extracted. Each open gets its own subfolder.
  stagingRoot: string;
  // Refuse the archive unless its SHA-256 matches (hex, any case).
  expectedSha256?: string;
}

// Files that never belong in an installed plugin.
const SKIP_NAMES = new Set([".git", ".svn", ".DS_Store", "Thumbs.db", "desktop.ini"]);

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function openPackage(path: string, options: OpenOptions): Promise<OpenedPackage> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new PackageError(`package not found: ${path}`);

  if (info.isDirectory()) {
    if (options.expectedSha256) {
      throw new PackageError("a SHA-256 can only be checked for a .zip package");
    }
    const manifest = await readManifest(path);
    await verifySources(path, manifest);
    return { root: path, manifest, close: async () => {} };
  }

  if (!/\.zip$/i.test(path)) {
    throw new PackageError(`expected a package folder or a .zip file: ${path}`);
  }

  const buf = await readFile(path);
  const hash = sha256(buf);
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== hash) {
    throw new PackageError(
      `SHA-256 mismatch for ${path}\n  expected ${options.expectedSha256.toLowerCase()}\n  actual   ${hash}`,
    );
  }

  const staging = join(options.stagingRoot, `pkg-${randomBytes(6).toString("hex")}`);
  const close = () => rm(staging, { recursive: true, force: true });
  try {
    await extractZip(buf, staging);
    const manifest = await readManifest(staging).catch((err: Error) => {
      throw new PackageError(`${err.message}\n  (${MANIFEST_FILE} must sit at the root of the zip)`);
    });
    await verifySources(staging, manifest);
    return { root: staging, manifest, archive: { path, sha256: hash }, close };
  } catch (err) {
    await close();
    throw err;
  }
}

// Every entry is checked before anything is written, so a zip with one bad
// path (an absolute path or "../") extracts nothing at all.
export async function extractZip(buf: Uint8Array, dest: string): Promise<void> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch (err) {
    throw new PackageError(`not a readable zip: ${(err as Error).message}`);
  }

  const root = resolve(dest);
  const files: [string, Uint8Array][] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (!isSafeRelativePath(name)) throw new PackageError(`unsafe path in archive: ${name}`);
    const target = resolve(root, ...name.split(/[\\/]/));
    if (!target.startsWith(root + sep)) throw new PackageError(`unsafe path in archive: ${name}`);
    files.push([target, data]);
  }

  await mkdir(root, { recursive: true });
  for (const [target, data] of files) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

async function verifySources(root: string, manifest: Manifest): Promise<void> {
  for (const c of manifest.components) {
    const full = join(root, c.source);
    const info = await stat(full).catch(() => null);
    if (!info) throw new PackageError(`${c.type} source not found in package: ${c.source}`);

    const wantsDir = c.type === "cep";
    const wantsFile = c.type === "zxp" || c.type === "blender";
    if (wantsDir && !info.isDirectory()) throw new PackageError(`${c.type} source must be a folder: ${c.source}`);
    if (wantsFile && !info.isFile()) throw new PackageError(`${c.type} source must be a file: ${c.source}`);
    if (c.type === "cep" && !(await stat(join(full, "CSXS", "manifest.xml")).catch(() => null))) {
      throw new PackageError(`cep source has no CSXS/manifest.xml: ${c.source}`);
    }
  }
}

export interface PackResult {
  path: string;
  sha256: string;
  size: number;
  fileCount: number;
  manifest: Manifest;
}

// Builds <id>-<version>.zip from a package folder. Only zeploy.json and the
// component sources go in; everything else in the folder (tests, docs,
// version control) stays out.
export async function packPackage(folder: string, outDir: string): Promise<PackResult> {
  const manifest = await readManifest(folder);
  await verifySources(folder, manifest);

  const zip: Zippable = {};
  const add = async (rel: string) => {
    const key = rel.replace(/\\/g, "/");
    if (key in zip) return;
    const full = join(folder, rel);
    const info = await stat(full);
    zip[key] = [await readFile(full), { mtime: info.mtime }];
  };

  await add(MANIFEST_FILE);
  for (const c of manifest.components) {
    const full = join(folder, c.source);
    if ((await stat(full)).isDirectory()) {
      for (const rel of await listFiles(full)) {
        // .debug opens a remote debugging port for a CEP panel: development only.
        if (c.type === "cep" && rel === ".debug") continue;
        await add(join(c.source, rel));
      }
    } else {
      await add(c.source);
    }
  }

  const data = zipSync(zip, { level: 6 });
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `${manifest.id}-${manifest.version}.zip`);
  await writeFile(out, data);
  return { path: out, sha256: sha256(data), size: data.length, fileCount: Object.keys(zip).length, manifest };
}

// Relative paths of every file under dir, skipping version control and OS litter.
export async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    const info = await stat(join(dir, rel));
    if (info.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

// Script files the usage helpers come as (examples/usage), and archives a
// component may hold them in.
const HELPER_FILE = /\.(js|jsx|jsfl|py|html?)$/i;
const HELPER_ARCHIVE = /\.(zip|zxp|ccx)$/i;
const HELPER_MARK = /zeployUsageV1|zeploy usage helper/;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function archiveHasHelper(data: Uint8Array): boolean {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, { filter: (f) => HELPER_FILE.test(f.name) && f.originalSize <= MAX_SCAN_BYTES });
  } catch {
    return false;
  }
  return Object.values(entries).some((bytes) => HELPER_MARK.test(new TextDecoder().decode(bytes)));
}

// Whether a package reports plugin usage: one of its scripts carries
// zeploy's usage helper (docs/plugin-usage.md), found by the helper's
// function name or its header. Archives (a Blender add-on .zip, a .zxp) are
// looked into; a compiled .jsxbin cannot be.
export async function hasUsageHelper(root: string, manifest: Manifest): Promise<boolean> {
  for (const c of manifest.components) {
    const full = join(root, c.source);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    const files = info.isDirectory() ? (await listFiles(full)).map((rel) => join(full, rel)) : [full];
    for (const file of files) {
      if (HELPER_ARCHIVE.test(file)) {
        if (archiveHasHelper(await readFile(file))) return true;
      } else if (HELPER_FILE.test(file) && (await stat(file)).size <= MAX_SCAN_BYTES) {
        if (HELPER_MARK.test(await readFile(file, "utf8"))) return true;
      }
    }
  }
  return false;
}
