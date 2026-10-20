// One agent, several admin computers. A team can run the zeploy admin app on
// more than one PC; the agent keeps a connection to each of them, all with
// the same team token, and runs the jobs they send one at a time.
//
// The admins tell the agent about each other with the protocol's "admins"
// message, and the agent saves the list, so it reconnects to all of them
// after a restart.

import * as P from "../../protocol/src/index.ts";
import { startAgent, type AgentOptions, type AgentStatus, type RunningAgent } from "./agent.ts";

export interface AdminsOptions extends Omit<AgentOptions, "serverUrl" | "onStatus" | "exclusive" | "admins" | "onAdmins"> {
  servers: string[];
  // Saves the list after an admin added or removed one.
  saveServers?: (servers: string[]) => Promise<void>;
  onStatus?: (url: string, status: AgentStatus) => void;
}

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
  const { servers, saveServers, onStatus, ...agentOptions } = options;
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
      await applying;
      await Promise.all([...links.values()].map((l) => l.agent.stop()));
    },
  };
}
