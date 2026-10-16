// Agent configuration: %ProgramData%\zeploy\agent.json, one per PC.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateLegacyDir } from "../../core/src/index.ts";
import { DEFAULT_PORT } from "../../protocol/src/index.ts";

export interface AgentConfig {
  serverUrl?: string;
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

// "192.168.1.10", "192.168.1.10:7420" and "http://192.168.1.10:7420/" all
// become "http://192.168.1.10:7420".
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (!parsed.port) parsed.port = String(DEFAULT_PORT);
  return `${parsed.protocol}//${parsed.host}`;
}
