// Plugin usage on this PC. Plugins append one JSON line per event to
// <usage dir>\<plugin>.jsonl (the contract is in docs/plugin-usage.md):
//
//   {"v":1,"t":"2026-10-20T09:12:03.120Z","plugin":"com.colosave.panel","ver":"1.4.0","ev":"action","name":"export","ms":340}
//
// The agent renames each file before reading it, so a plugin writing at the
// same moment starts a new file, counts the lines into one row per day and
// plugin, and deletes the renamed files once an admin has stored them. Lines
// it cannot read are skipped; nothing a plugin writes can stop the agent.

import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRow } from "../../protocol/src/index.ts";

const SENDING = ".sending";
// Plugins stop writing at 512 KB; a larger file is read only this far.
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_NAMES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Spool {
  rows: UsageRow[];
  // The renamed files these rows came from, to delete once stored.
  files: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// The PC's own date, which is the day the team worked.
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Event names go to the admin as keys; anything unexpected becomes "_".
function cleanName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 40) : "";
  return name || fallback;
}

// Adds the events in `lines` to `rows`, keyed by day, plugin and app.
export function countLines(lines: Iterable<string>, rows: Map<string, UsageRow>, now = new Date()): void {
  for (const line of lines) {
    if (!line.trim() || line.length > 2000) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!e || e["v"] !== 1 || typeof e["plugin"] !== "string" || typeof e["t"] !== "string") continue;
    const plugin = e["plugin"].trim().slice(0, 120);
    const time = new Date(e["t"]);
    // A clock far off would put events on days that never come round.
    if (!plugin || Number.isNaN(time.getTime()) || Math.abs(time.getTime() - now.getTime()) > 400 * DAY_MS) continue;
    const ev = e["ev"];
    if (ev !== "open" && ev !== "action" && ev !== "error") continue;
    const app = typeof e["app"] === "string" && /^[a-z]{1,20}$/.test(e["app"]) ? e["app"] : undefined;
    const day = localDay(time);

    const key = `${day}|${plugin.toLowerCase()}|${app ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      if (rows.size >= MAX_ROWS) continue;
      row = { day, plugin, ...(app ? { app } : {}), opens: 0, actions: {}, errors: {}, versions: {}, last: time.toISOString() };
      rows.set(key, row);
    }
    if (time.toISOString() > row.last) row.last = time.toISOString();
    const ver = typeof e["ver"] === "string" ? e["ver"].trim().slice(0, 32) : "";
    if (ver && (ver in row.versions || Object.keys(row.versions).length < MAX_NAMES)) {
      row.versions[ver] = (row.versions[ver] ?? 0) + 1;
    }

    if (ev === "open") {
      row.opens++;
    } else if (ev === "action") {
      let name = cleanName(e["name"], "use");
      if (!(name in row.actions) && Object.keys(row.actions).length >= MAX_NAMES) name = "other";
      const ms = typeof e["ms"] === "number" && e["ms"] >= 0 && e["ms"] < DAY_MS ? Math.round(e["ms"]) : 0;
      const a = (row.actions[name] ??= { n: 0, ms: 0 });
      a.n++;
      a.ms += ms;
    } else {
      let name = cleanName(e["name"], "error");
      if (!(name in row.errors) && Object.keys(row.errors).length >= MAX_NAMES) name = "other";
      row.errors[name] = (row.errors[name] ?? 0) + 1;
    }
  }
}

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

// Renames the plugins' files and counts them, with files left from an
// earlier round that no admin confirmed.
export async function takeSpool(dir: string, now = new Date()): Promise<Spool> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".jsonl"))) {
    // Fails while a plugin has the file open; it is taken next round.
    await rename(join(dir, name), join(dir, `${name}.${now.getTime()}${SENDING}`)).catch(() => {});
  }
  const sending = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(SENDING)).sort();
  const rows = new Map<string, UsageRow>();
  const files: string[] = [];
  for (const name of sending) {
    const file = join(dir, name);
    const text = await readHead(file).catch(() => null);
    if (text === null) continue;
    const before = new Map([...rows].map(([k, v]) => [k, structuredClone(v)]));
    countLines(text.split(/\r?\n/), rows, now);
    // A file that did not fit waits for the next round, whole.
    if (rows.size >= MAX_ROWS && files.length > 0) {
      rows.clear();
      for (const [k, v] of before) rows.set(k, v);
      break;
    }
    files.push(file);
  }
  return { rows: [...rows.values()], files };
}

export async function dropSpool(files: string[]): Promise<void> {
  for (const file of files) await rm(file, { force: true }).catch(() => {});
}

// Usage is switched off: what plugins wrote is not kept.
export async function clearSpool(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await dropSpool(names.filter((n) => /\.jsonl$|\.sending$/i.test(n)).map((n) => join(dir, n)));
}
