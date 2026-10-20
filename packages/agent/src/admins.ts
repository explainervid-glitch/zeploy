// One agent, several admin computers. A team can run the zeploy admin app on
// more than one PC; the agent keeps a connection to each of them, all with
// the same team token, and runs the jobs they send one at a time.
//
// The admins tell the agent about each other with the protocol's "admins"
// message, and the agent saves the list, so it reconnects to all of them
// after a restart.

import { randomUUID } from "node:crypto";
import * as P from "../../protocol/src/index.ts";
import { startAgent, type AgentOptions, type AgentStatus, type RunningAgent } from "./agent.ts";
import { clearSpool, dropSpool, takeSpool } from "./usage.ts";

export interface AdminsOptions
  extends Omit<AgentOptions, "serverUrl" | "onStatus" | "exclusive" | "admins" | "onAdmins" | "onUsageAck"> {
  servers: string[];
  // Saves the list after an admin added or removed one.
  saveServers?: (servers: string[]) => Promise<void>;
  onStatus?: (url: string, status: AgentStatus) => void;
  // Where plugins write their usage (usage.ts). Without it, none is reported.
  usageDir?: string;
  usageIntervalMs?: number;
}

const USAGE_INTERVAL_MS = 60_000;
// A batch no admin confirmed in this time is sent again in the next round.
const USAGE_ACK_MS = 2 * 60_000;

export interface RunningAdmins {
  readonly servers: string[];
  status(url: string): AgentStatus | undefined;
  stop(): Promise<void>;
  idle(): Promise<void>;
}

interface Link {
  agent: RunningAgent;
  status: AgentStatus;
}

export function startAdmins(options: AdminsOptions): RunningAdmins {
  const { servers, saveServers, onStatus, usageDir, usageIntervalMs, ...agentOptions } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const links = new Map<string, Link>();

  // Jobs from different admins never run at the same time.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run);
    chain = next.catch(() => {});
    return next;
  };

  const report = (except?: string) => {
    for (const [url, link] of links) if (url !== except) link.agent.report();
  };

  // Each admin hears about the others when one connects, drops or rejects
  // the token, not on every retry of an admin that is off.
  const kind = (s: AgentStatus) => (s === "connected" || s === "rejected" ? s : "other");

  function open(url: string): void {
    const link: Link = { status: "connecting", agent: null as unknown as RunningAgent };
    links.set(url, link);
    link.agent = startAgent({
      ...agentOptions,
      serverUrl: url,
      exclusive,
      admins: () => [...links].map(([u, l]) => ({ url: u, status: l.status, ...(u === url ? { current: true } : {}) })),
      onAdmins: (change) => void apply(change),
      onUsageAck: usageDir ? (id) => void acked(id) : undefined,
      onStatus: (status) => {
        const before = link.status;
        link.status = status;
        onStatus?.(url, status);
        if (kind(before) !== kind(status)) report(url);
      },
    });
  }

  let applying: Promise<void> = Promise.resolve();
  function apply(change: { add: string[]; remove: string[] }): Promise<void> {
    applying = applying.then(async () => {
      const norm = (raw: string) => {
        try {
          return P.normalizeServerUrl(raw);
        } catch {
          return null;
        }
      };
      let changed = false;
      for (const url of change.add.map(norm)) {
        if (!url || links.has(url) || links.size >= 16) continue;
        log(`admin computer added: ${url}`);
        open(url);
        changed = true;
      }
      for (const url of change.remove.map(norm)) {
        const link = url ? links.get(url) : undefined;
        // The last admin stays: without one, nobody could reach this PC.
        if (!url || !link || links.size <= 1) continue;
        log(`admin computer removed: ${url}`);
        links.delete(url);
        await link.agent.stop();
        changed = true;
      }
      if (!changed) return;
      await saveServers?.([...links.keys()]).catch((err: Error) => log(`could not save the admin list: ${err.message}`));
      report();
    });
    return applying;
  }

  // ---- plugin usage: every admin that wants it gets each batch; the first
  // to confirm it lets the agent delete the files. An admin that is off at
  // that time misses the batch.
  let pending: { id: string; files: string[]; at: number } | null = null;
  let ticking = false;

  async function acked(id: string): Promise<void> {
    if (pending?.id !== id) return;
    const { files } = pending;
    pending = null;
    await dropSpool(files);
  }

  async function usageRound(): Promise<void> {
    if (!usageDir || ticking) return;
    ticking = true;
    try {
      if (pending && Date.now() - pending.at < USAGE_ACK_MS) return;
      pending = null;
      const connected = [...links.values()].filter((l) => l.agent.wantsUsage !== null);
      const wanting = connected.filter((l) => l.agent.wantsUsage);
      if (wanting.length === 0) {
        // Every admin that answered switched usage off: nothing is kept.
        if (connected.length > 0) await clearSpool(usageDir);
        return;
      }
      const spool = await takeSpool(usageDir);
      if (spool.rows.length === 0) {
        await dropSpool(spool.files);
        return;
      }
      const batch = { id: randomUUID(), files: spool.files, at: Date.now() };
      if (wanting.map((l) => l.agent.sendUsage(batch.id, spool.rows)).some(Boolean)) pending = batch;
    } catch (err) {
      log(`could not report plugin usage: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  }
  const usageTimer = usageDir ? setInterval(() => void usageRound(), usageIntervalMs ?? USAGE_INTERVAL_MS) : null;

  for (const url of new Set(servers.map(P.normalizeServerUrl))) open(url);

  return {
    get servers() {
      return [...links.keys()];
    },
    status: (url) => links.get(P.normalizeServerUrl(url))?.status,
    idle: async () => {
      await applying;
      await Promise.all([...links.values()].map((l) => l.agent.idle()));
      await chain;
    },
    async stop() {
      if (usageTimer) clearInterval(usageTimer);
      await applying;
      await Promise.all([...links.values()].map((l) => l.agent.stop()));
    },
  };
}
