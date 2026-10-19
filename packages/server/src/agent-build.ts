// The zeploy-agent.exe this admin hands out, for agent updates. Its version
// comes from zeploy-agent.json, which scripts/build.mjs writes next to it:
// the version has to describe that exact exe, and the admin app may well be
// built from newer sources than the agent exe it bundles.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export interface AgentBuild {
  exe: string;
  version: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

const sidecarSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+/).max(64) });

export function sidecarPath(exe: string): string {
  return exe.replace(/\.exe$/i, "") + ".json";
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Null when there is no exe, or no readable version for it. `known` is the
// previous result: the exe is hashed again only when it changed.
export async function readAgentBuild(exe: string | undefined, known: AgentBuild | null): Promise<AgentBuild | null> {
  if (!exe) return null;
  const info = await stat(exe).catch(() => null);
  if (!info?.isFile()) return null;
  let version: string;
  try {
    version = sidecarSchema.parse(JSON.parse(await readFile(sidecarPath(exe), "utf8"))).version;
  } catch {
    return null;
  }
  if (known && known.exe === exe && known.size === info.size && known.mtimeMs === info.mtimeMs) {
    return { ...known, version };
  }
  return { exe, version, sha256: await sha256Of(exe), size: info.size, mtimeMs: info.mtimeMs };
}
