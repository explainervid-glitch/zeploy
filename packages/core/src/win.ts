// Thin wrappers over the Windows tools the engine needs: reg.exe, tasklist,
// taskkill and running installers. Nothing here needs a native module.

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

// "net session" only succeeds in an elevated process.
export async function isElevated(): Promise<boolean> {
  try {
    return (await run("net", ["session"])).code === 0;
  } catch {
    return false;
  }
}

// Image names of every running process, lower-cased ("afterfx.exe").
export async function listProcesses(): Promise<Set<string>> {
  const { code, stdout, stderr } = await run("tasklist", ["/FO", "CSV", "/NH"]);
  if (code !== 0) throw new Error(`tasklist failed: ${stderr.trim() || stdout.trim()}`);
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m?.[1]) names.add(m[1].toLowerCase());
  }
  return names;
}

export async function killProcess(imageName: string): Promise<void> {
  const { code, stdout, stderr } = await run("taskkill", ["/F", "/IM", imageName]);
  if (code !== 0) throw new Error(`taskkill ${imageName} failed: ${stderr.trim() || stdout.trim()}`);
}

// key is a full reg.exe path such as "HKCU\\Software\\Adobe\\CSXS.12".
export async function regSetString(key: string, name: string, value: string): Promise<void> {
  const { code, stdout, stderr } = await run("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
  if (code !== 0) throw new Error(`reg add ${key} /v ${name} failed: ${stderr.trim() || stdout.trim()}`);
}
