// Plugin usage the agents report, kept as daily totals per PC and plugin in
// usage.json beside state.json. Nothing finer is stored: no times of day, no
// user names, no event details beyond the plugin's own short names.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRow } from "../../protocol/src/index.ts";
import { JsonFile, type JsonFileOptions } from "./json-file.ts";

type DayRow = Omit<UsageRow, "day">;

interface UsageData {
  version: 1;
  // day ("2026-10-20") -> agent id -> rows (one per plugin and app).
  days: Record<string, Record<string, DayRow[]>>;
}

export const KEEP_DAYS = 180;

export interface PluginUsage {
  // The plugin's own id, as it reports it.
  plugin: string;
  apps: string[];
  opens: number;
  // Features used: the number that says whether a plugin is in use.
  uses: number;
  actions: Record<string, { n: number; ms: number }>;
  errors: number;
  versions: Record<string, number>;
  last: string;
  // Per PC, by agent id.
  agents: Record<string, { opens: number; uses: number; last: string }>;
  // Per day ("2026-10-20"), for charts.
  perDay: Record<string, { opens: number; uses: number; errors: number }>;
}

function addRecord<T extends string>(into: Record<T, number>, from: Record<T, number>): void {
  for (const [k, v] of Object.entries(from) as [T, number][]) into[k] = (into[k] ?? 0) + v;
}

function merge(into: DayRow, row: DayRow): void {
  into.opens += row.opens;
  for (const [name, a] of Object.entries(row.actions)) {
    const t = (into.actions[name] ??= { n: 0, ms: 0 });
    t.n += a.n;
    t.ms += a.ms;
  }
  addRecord(into.errors, row.errors);
  addRecord(into.versions, row.versions);
  if (row.last > into.last) into.last = row.last;
}

// The first day of the last `days` days, today included.
export function firstDay(days: number, now = new Date()): string {
  return localDay(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class UsageStore {
  readonly #file: JsonFile;
  #data: UsageData;
  #timer: NodeJS.Timeout | null = null;

  private constructor(file: JsonFile, data: UsageData) {
    this.#file = file;
    this.#data = data;
  }

  static async open(dir: string, options: JsonFileOptions = {}): Promise<UsageStore> {
    await mkdir(dir, { recursive: true });
    const file = new JsonFile(join(dir, "usage.json"), options);
    return new UsageStore(file, (await file.read<UsageData>()) ?? { version: 1, days: {} });
  }

  add(agentId: string, rows: UsageRow[]): void {
    for (const { day, ...row } of rows) {
      const perAgent = ((this.#data.days[day] ??= {})[agentId] ??= []);
      const same = perAgent.find((r) => r.plugin.toLowerCase() === row.plugin.toLowerCase() && r.app === row.app);
      if (same) merge(same, row);
      else perAgent.push(structuredClone(row));
    }
    this.save();
  }

  // Everything from the last `days` days, today included, per plugin.
  summary(days: number, now = new Date()): PluginUsage[] {
    const from = firstDay(days, now);
    const plugins = new Map<string, PluginUsage>();
    for (const [day, perAgent] of Object.entries(this.#data.days)) {
      if (day < from) continue;
      for (const [agentId, rows] of Object.entries(perAgent)) {
        for (const row of rows) {
          const key = row.plugin.toLowerCase();
          let p = plugins.get(key);
          if (!p) {
            p = { plugin: row.plugin, apps: [], opens: 0, uses: 0, actions: {}, errors: 0, versions: {}, last: "", agents: {}, perDay: {} };
            plugins.set(key, p);
          }
          const uses = Object.values(row.actions).reduce((n, a) => n + a.n, 0);
          if (row.app && !p.apps.includes(row.app)) p.apps.push(row.app);
          p.opens += row.opens;
          p.uses += uses;
          for (const [name, a] of Object.entries(row.actions)) {
            const t = (p.actions[name] ??= { n: 0, ms: 0 });
            t.n += a.n;
            t.ms += a.ms;
          }
          const errors = Object.values(row.errors).reduce((n, v) => n + v, 0);
          p.errors += errors;
          const d = (p.perDay[day] ??= { opens: 0, uses: 0, errors: 0 });
          d.opens += row.opens;
          d.uses += uses;
          d.errors += errors;
          addRecord(p.versions, row.versions);
          if (row.last > p.last) p.last = row.last;
          const a = (p.agents[agentId] ??= { opens: 0, uses: 0, last: "" });
          a.opens += row.opens;
          a.uses += uses;
          if (row.last > a.last) a.last = row.last;
        }
      }
    }
    return [...plugins.values()];
  }

  // Writes are coalesced, like the main store's; old days go on the way out.
  save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush().catch(() => {});
    }, 500);
  }

  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#file.write(() => {
      const oldest = localDay(new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000));
      for (const day of Object.keys(this.#data.days)) if (day < oldest) delete this.#data.days[day];
      return JSON.stringify(this.#data);
    });
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.#file.stop();
    }
  }
}
