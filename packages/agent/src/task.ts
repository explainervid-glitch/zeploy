// Installing the agent on a team PC: a copy under Program Files, started by a
// Scheduled Task at the user's logon with highest privileges. Running as the
// logged-on user (elevated) gives the agent both Program Files and that
// user's own folders (HKCU, %APPDATA%, Blender preferences).

import { join } from "node:path";
import { run } from "../../core/src/index.ts";

export const TASK_NAME = "zeploy agent";
// The names used before the app was renamed from "zdeploy" to "zeploy".
export const LEGACY_TASK_NAME = "zdeploy agent";

const programFiles = () => process.env["ProgramFiles"] ?? "C:\\Program Files";

export function installedExePath(): string {
  return join(programFiles(), "zeploy", "zeploy-agent.exe");
}

export function legacyExeDir(): string {
  return join(programFiles(), "zdeploy");
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function powershell(script: string): Promise<void> {
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `powershell exited ${r.code}`);
}

// DOMAIN\name of this process: the user the agent runs as.
export function currentUser(): string {
  return `${process.env["USERDOMAIN"] ?? "."}\\${process.env["USERNAME"] ?? ""}`;
}

export async function registerTask(exe: string): Promise<void> {
  const user = currentUser();
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

// The waker (waker.ts): the same exe as SYSTEM from boot, restarted every
// minute should it stop, and let through Windows Firewall from the local
// network only. Re-registering restarts it, so it runs the exe now in place.
export const WAKER_TASK_NAME = "zeploy waker";
const WAKER_FIREWALL_RULE = "zeploy waker";

export async function installWaker(exe: string, home: string, user: string, port: number): Promise<void> {
  await powershell(
    [
      `$a = New-ScheduledTaskAction -Execute ${psQuote(exe)} -Argument ${psQuote(`waker --home "${home}" --user "${user}"`)}`,
      `$t = New-ScheduledTaskTrigger -AtStartup`,
      `$p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable ` +
        `-ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `Register-ScheduledTask -TaskName ${psQuote(WAKER_TASK_NAME)} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
      `Remove-NetFirewallRule -DisplayName ${psQuote(WAKER_FIREWALL_RULE)} -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName ${psQuote(WAKER_FIREWALL_RULE)} -Direction Inbound -Action Allow -Protocol TCP ` +
        `-LocalPort ${port} -RemoteAddress LocalSubnet -Program ${psQuote(exe)} -Profile Any | Out-Null`,
      `Stop-ScheduledTask -TaskName ${psQuote(WAKER_TASK_NAME)} -ErrorAction SilentlyContinue`,
      `Start-ScheduledTask -TaskName ${psQuote(WAKER_TASK_NAME)}`,
    ].join("; "),
  );
}

export async function removeWaker(): Promise<boolean> {
  try {
    await powershell(
      `Stop-ScheduledTask -TaskName ${psQuote(WAKER_TASK_NAME)} -ErrorAction SilentlyContinue; ` +
        `Remove-NetFirewallRule -DisplayName ${psQuote(WAKER_FIREWALL_RULE)} -ErrorAction SilentlyContinue`,
    );
  } catch {}
  return removeTask(WAKER_TASK_NAME);
}

export async function removeTask(name = TASK_NAME): Promise<boolean> {
  try {
    await powershell(`Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false -ErrorAction Stop`);
    return true;
  } catch {
    return false;
  }
}
