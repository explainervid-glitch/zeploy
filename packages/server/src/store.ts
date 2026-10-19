// The admin server's state, kept in one JSON file. A team of under ten PCs
// with a handful of packages does not need a database, and a JSON file is
// easy to inspect, back up and repair by hand.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentState, JobOptions } from "../../protocol/src/index.ts";
import { randomToken } from "../../protocol/src/index.ts";

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
}

export interface AgentRecord {
  id: string;
  // Name the admin gave this PC in zeploy; the Windows name stays `hostname`.
  label?: string;
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
}

export interface StoreData {
  version: 1;
  // Shared secret every agent is configured with.
  enrollToken: string;
  packages: PackageRecord[];
  agents: Record<string, AgentRecord>;
  jobs: JobRecord[];
}

const MAX_JOBS = 300;
export const MAX_JOB_LOG_LINES = 500;

export class Store {
  readonly dir: string;
  data: StoreData;
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<void> = Promise.resolve();

  private constructor(dir: string, data: StoreData) {
    this.dir = dir;
    this.data = data;
  }

  static async open(dir: string): Promise<Store> {
    await mkdir(dir, { recursive: true });
    let data: StoreData;
    try {
      data = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as StoreData;
    } catch {
      data = { version: 1, enrollToken: randomToken(), packages: [], agents: {}, jobs: [] };
    }
    const store = new Store(dir, data);
    await store.flush();
    return store;
  }

  // Writes are coalesced: a running job can log many lines a second.
  save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.data.jobs.length > MAX_JOBS) this.data.jobs.splice(0, this.data.jobs.length - MAX_JOBS);
    const text = JSON.stringify(this.data, null, 2);
    const file = join(this.dir, "state.json");
    this.#writing = this.#writing.then(async () => {
      await writeFile(`${file}.tmp`, text);
      await rename(`${file}.tmp`, file);
    });
    return this.#writing;
  }
}
