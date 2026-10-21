// The admin server's state, kept in one JSON file. A team of under ten PCs
// with a handful of packages does not need a database, and a JSON file is
// easy to inspect, back up and repair by hand.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentState, JobOptions } from "../../protocol/src/index.ts";
import { randomToken } from "../../protocol/src/index.ts";
import { JsonFile, type JsonFileOptions } from "./json-file.ts";

export interface PackageRecord {
  id: string;
  name: string;
  version: string;
  sha256: string;
  size: number;
  // File name under <dataDir>/packages.
  file: string;
  addedAt: string;
  components: { type: string; source: string }[];
  // Plugin identities ("cep:com.colosave.panel"), so a later version added
  // without zeploy.json joins this package. Missing on packages added
  // before zeploy read plugin files.
  keys?: string[];
  // The folder or file it was added from, so the admin app can read it again
  // for a newer version. Missing for uploads and older packages.
  source?: string;
  // Apps it installs into ("aftereffects", "blender"); the admin UI groups
  // packages by them.
  apps?: string[];
}

export interface AgentRecord {
  id: string;
  // Name the admin gave this PC in zeploy; the Windows name stays `hostname`.
  label?: string;
  // Role the admin gave this PC ("Animator", "Compositor"); the admin UI
  // groups PCs by it.
  role?: string;
  hostname: string;
  user: string;
  agentVersion: string;
  // FEATURE_* values from the protocol; missing for agents before 0.3.0.
  features?: string[];
  address: string;
  firstSeen: string;
  lastSeen: string;
  state: AgentState | null;
}

export type JobStatus = "queued" | "sent" | "running" | "done" | "failed";

// packageId of an updateAgent job, whose version is the agent version.
export const AGENT_PACKAGE_ID = "zeploy-agent";

export interface JobRecord {
  id: string;
  agentId: string;
  action: "install" | "uninstall" | "updateAgent";
  packageId: string;
  version?: string;
  options: JobOptions;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
  error?: string;
  // A done install that failed in some parts ("Blender 4.5: ..."): partly done.
  partial?: string[];
}

export interface StoreData {
  version: 1;
  // Shared secret every agent is configured with.
  enrollToken: string;
  // The team's other admin computers ("http://192.168.1.80:7420"), which
  // agents connect to as well, and the ones removed, so agents that were
  // offline then drop them when they connect.
  admins?: string[];
  removedAdmins?: string[];
  // Whether agents report plugin usage to this admin; absent means yes.
  usage?: boolean;
  packages: PackageRecord[];
  agents: Record<string, AgentRecord>;
  jobs: JobRecord[];
}

const MAX_JOBS = 300;
export const MAX_JOB_LOG_LINES = 500;

export class Store {
  readonly dir: string;
  data: StoreData;
  readonly #file: JsonFile;
  #timer: NodeJS.Timeout | null = null;

  private constructor(dir: string, data: StoreData, file: JsonFile) {
    this.dir = dir;
    this.data = data;
    this.#file = file;
  }

  // A new, empty store only when there is no state.json yet. One that cannot
  // be read stops the server instead: starting empty would overwrite it.
  static async open(dir: string, options: JsonFileOptions = {}): Promise<Store> {
    await mkdir(dir, { recursive: true });
    const file = new JsonFile(join(dir, "state.json"), options);
    const data = (await file.read<StoreData>()) ?? { version: 1, enrollToken: randomToken(), packages: [], agents: {}, jobs: [] };
    const store = new Store(dir, data, file);
    await store.flush();
    return store;
  }

  // Writes are coalesced: a running job can log many lines a second. A
  // failed write is logged and tried again (json-file.ts).
  save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush().catch(() => {});
    }, 250);
  }

  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#file.write(() => {
      if (this.data.jobs.length > MAX_JOBS) this.data.jobs.splice(0, this.data.jobs.length - MAX_JOBS);
      return JSON.stringify(this.data, null, 2);
    });
  }

  // Saves what is left and stops retrying.
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.#file.stop();
    }
  }
}
