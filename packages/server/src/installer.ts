// The one-click installer for team PCs: "Install zeploy agent.cmd", saved
// next to a copy of zeploy-agent.exe. Double-clicking it on a team PC
// installs the agent with one UAC prompt, so nobody types a command into an
// administrator terminal.
//
// The .cmd runs twice. First as the signed-in user: it checks that user is a
// local administrator (the agent is set up for whoever approves the prompt),
// copies itself and the exe to %TEMP% because an elevated process cannot see
// mapped drives such as Z:, and asks for elevation. Then, elevated, from that
// local copy: it runs `zeploy-agent.exe setup` with the server and token
// written into the file.

import { copyFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HttpError } from "./packages.ts";

export const INSTALLER_NAME = "Install zeploy agent.cmd";
export const AGENT_EXE_NAME = "zeploy-agent.exe";

// Both values are written into a batch file unquoted, so only characters
// with no meaning to cmd.exe are allowed. Team tokens are base64url.
const SAFE_SERVER = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderInstallerCmd(server: string, token: string, generatedAt = new Date()): string {
  if (!SAFE_SERVER.test(server)) throw new HttpError(400, `not a usable server address: ${server}`);
  if (!SAFE_TOKEN.test(token)) throw new HttpError(400, "the team token contains characters a .cmd file cannot hold");

  const lines = [
    "@echo off",
    "setlocal EnableExtensions DisableDelayedExpansion",
    "rem ==================================================================",
    "rem  zeploy agent installer, made by the zeploy admin app.",
    `rem  Admin server: ${server}    Made: ${stamp(generatedAt)}`,
    "rem",
    "rem  This file contains the team token. Keep it where only the team",
    "rem  can open it, and delete it once the team PCs are set up.",
    "rem ==================================================================",
    `set "ZD_SERVER=${server}"`,
    `set "ZD_TOKEN=${token}"`,
    "title zeploy agent installer",
    'if /i "%~1"=="elevated" goto elevated',
    "",
    "rem ---- Run 1, as the signed-in user ----------------------------------",
    "rem Paths and names are only printed outside ( ) blocks and in quotes:",
    "rem a ) or & in them would otherwise end the block or split the line.",
    'set "ZD_EXE=%~dp0zeploy-agent.exe"',
    'if not exist "%ZD_EXE%" goto noexe',
    "",
    "rem The agent is set up for the account that approves the Windows prompt,",
    "rem so that must be this signed-in user. S-1-5-32-544 is Administrators.",
    'whoami /groups | findstr /c:"S-1-5-32-544" >nul',
    "if errorlevel 1 goto notadmin",
    "",
    "rem An elevated window cannot see mapped drives such as Z:, so this file",
    "rem and the agent are copied to a local folder before asking for rights.",
    'set "ZD_STAGE=%TEMP%\\zeploy-agent-setup"',
    'if exist "%ZD_STAGE%" rmdir /s /q "%ZD_STAGE%"',
    'mkdir "%ZD_STAGE%" || goto copyfailed',
    'copy /y "%ZD_EXE%" "%ZD_STAGE%\\zeploy-agent.exe" >nul || goto copyfailed',
    'copy /y "%~f0" "%ZD_STAGE%\\install.cmd" >nul || goto copyfailed',
    "",
    "echo Windows will ask whether zeploy agent may make changes. Choose Yes.",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command " +
      "\"try { $p = Start-Process -FilePath (Join-Path $env:ZD_STAGE 'install.cmd') -ArgumentList 'elevated' " +
      "-Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }\"",
    'set "ZD_RESULT=%errorlevel%"',
    'rmdir /s /q "%ZD_STAGE%" 2>nul',
    'if "%ZD_RESULT%"=="1223" (',
    "  echo Setup was cancelled. Nothing was installed.",
    "  pause",
    ")",
    "exit /b %ZD_RESULT%",
    "",
    ":noexe",
    "echo zeploy-agent.exe was not found next to this file, in",
    'echo   "%~dp0"',
    "echo Keep both files in the same folder and try again.",
    "pause",
    "exit /b 1",
    "",
    ":notadmin",
    'echo The account "%USERNAME%" is not a local administrator on this PC.',
    "echo Make this account an administrator, sign in again, then run this file again.",
    "pause",
    "exit /b 1",
    "",
    ":copyfailed",
    'echo Could not copy the installer to "%ZD_STAGE%".',
    "pause",
    "exit /b 1",
    "",
    "rem ---- Run 2, elevated, from the local copy --------------------------",
    ":elevated",
    '"%~dp0zeploy-agent.exe" setup --server %ZD_SERVER% --token %ZD_TOKEN%',
    "if errorlevel 1 (",
    "  echo.",
    "  echo Setup did not finish. Read the message above, then close this window.",
    "  pause",
    "  exit /b 1",
    ")",
    "echo.",
    "echo The zeploy agent is installed and running. This window closes in 10 seconds.",
    "timeout /t 10 >nul",
    "exit /b 0",
  ];
  return lines.join("\r\n") + "\r\n";
}

export interface SavedInstaller {
  cmd: string;
  exe: string;
}

// Writes the .cmd and a copy of the agent into an existing folder, replacing
// earlier copies there.
export async function writeInstaller(
  folder: string,
  options: { server: string; token: string; agentExe?: string },
): Promise<SavedInstaller> {
  const agent = options.agentExe;
  if (!agent || !(await stat(agent).catch(() => null))?.isFile()) {
    throw new HttpError(409, "zeploy-agent.exe is not built yet; run npm run build:agent, then npm run admin");
  }
  if (!(await stat(folder).catch(() => null))?.isDirectory()) {
    throw new HttpError(400, `folder not found: ${folder}`);
  }
  const text = renderInstallerCmd(options.server, options.token);
  const exe = join(folder, AGENT_EXE_NAME);
  if (resolve(exe).toLowerCase() !== resolve(agent).toLowerCase()) await copyFile(agent, exe);
  const cmd = join(folder, INSTALLER_NAME);
  await writeFile(cmd, text);
  return { cmd, exe };
}
