// Installing the agent on a team PC: a copy under Program Files, started by a
// Scheduled Task at the user's logon with highest privileges. Running as the
// logged-on user (elevated) gives the agent both Program Files and that
// user's own folders (HKCU, %APPDATA%, Blender preferences).

import { join } from "node:path";
import { run } from "../../core/src/index.ts";

export const TASK_NAME = "zdeploy agent";

export function installedExePath(): string {
  return join(process.env["ProgramFiles"] ?? "C:\\Program Files", "zdeploy", "zdeploy-agent.exe");
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function powershell(script: string): Promise<void> {
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `powershell exited ${r.code}`);
}

export async function registerTask(exe: string): Promise<void> {
  const user = `${process.env["USERDOMAIN"] ?? "."}\\${process.env["USERNAME"] ?? ""}`;
  // conhost --headless keeps the console window of the agent hidden.
  await powershell(
    [
      `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(`--headless "${exe}" run`)}`,
      `$t = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(user)}`,
      `$p = New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType Interactive -RunLevel Highest`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ` +
        `-ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
    ].join("; "),
  );
}

export async function startTask(): Promise<void> {
  await powershell(`Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}`);
}

export async function removeTask(): Promise<boolean> {
  try {
    await powershell(`Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction Stop`);
    return true;
  } catch {
    return false;
  }
}
