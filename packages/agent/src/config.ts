// Agent configuration: %ProgramData%\zdeploy\agent.json, one per PC.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "../../protocol/src/index.ts";

export interface AgentConfig {
  serverUrl?: string;
  token?: string;
  agentId?: string;
}

export function configPath(): string {
  return (
    process.env["ZDEPLOY_AGENT_CONFIG"] ??
    join(process.env["ProgramData"] ?? "C:\\ProgramData", "zdeploy", "agent.json")
  );
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
