// Agent configuration: %ProgramData%\zeploy\agent.json, one per PC.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateLegacyDir } from "../../core/src/index.ts";
import { normalizeServerUrl } from "../../protocol/src/index.ts";

export { normalizeServerUrl };

export interface AgentConfig {
  // The admin computer setup was run for. Agents before 0.7.0 read only this.
  serverUrl?: string;
  // Every admin computer to connect to, serverUrl among them. Admins add and
  // remove entries (see the protocol's "admins" message).
  servers?: string[];
  token?: string;
  agentId?: string;
}

export function configPath(): string {
  const custom = process.env["ZEPLOY_AGENT_CONFIG"];
  if (custom) return custom;
  const programData = process.env["ProgramData"] ?? "C:\\ProgramData";
  // Keeps the PC id of an agent installed as "zdeploy", so it stays one row.
  migrateLegacyDir(join(programData, "zdeploy"), join(programData, "zeploy"));
  return join(programData, "zeploy", "agent.json");
}

export async function loadConfig(): Promise<AgentConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as AgentConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
}

export function newAgentId(): string {
  return randomUUID();
}

// The admin computers to connect to: the saved list with the one setup was
// last run for first.
export function serversOf(config: AgentConfig): string[] {
  const list = [config.serverUrl, ...(config.servers ?? [])].filter((s): s is string => !!s);
  return [...new Set(list.map(normalizeServerUrl))];
}
