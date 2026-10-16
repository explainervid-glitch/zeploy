// File system helpers that are careful about links.
//
// Developers install their own panels as symbolic links or junctions pointing
// back at the working copy. A recursive delete that followed such a link would
// wipe the source repository, so every removal here deletes a link as a link.

import { existsSync, renameSync } from "node:fs";
import { cp, lstat, mkdir, readlink, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";

// The app was called "zdeploy" before "zeploy". Moves a folder from its old
// name once, so settings, receipts and the team token carry over. Best
// effort: if the move fails, the new folder simply starts empty.
export function migrateLegacyDir(legacy: string, current: string): void {
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, current);
  } catch {
    // Folder in use or not ours to move; nothing to carry over then.
  }
}

// Target of a symbolic link or junction, or null for anything else
// (including a path that does not exist).
export async function linkTarget(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isSymbolicLink()) return null;
  return readlink(path).catch(() => "(unreadable link)");
}

export async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

// Returns false when there was nothing to remove.
export async function removeSafe(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (!info) return false;
  if (info.isSymbolicLink()) {
    try {
      await unlink(path);
    } catch {
      await rmdir(path);
    }
    return true;
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

// Names never copied into an installed plugin.
const ALWAYS_SKIP = new Set([".git", ".svn", ".ds_store", "thumbs.db", "desktop.ini"]);

// Copies `from` to `to` through a sibling temp folder, so a failed copy leaves
// the previous install in place.
export async function replaceDir(from: string, to: string, exclude: string[] = []): Promise<void> {
  const skip = new Set(exclude.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  const tmp = `${to}.zeploy-new`;
  await removeSafe(tmp);
  await mkdir(dirname(to), { recursive: true });
  try {
    await cp(from, tmp, {
      recursive: true,
      filter: (src) => {
        if (ALWAYS_SKIP.has(basename(src).toLowerCase())) return false;
        const rel = relative(from, src).replace(/\\/g, "/").toLowerCase();
        return !skip.has(rel);
      },
    });
    await removeSafe(to);
    await rename(tmp, to);
  } catch (err) {
    await removeSafe(tmp).catch(() => {});
    throw err;
  }
}
