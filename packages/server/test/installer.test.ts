import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTmp, write } from "../../core/test/helpers.ts";
import { AGENT_EXE_NAME, INSTALLER_NAME, renderInstallerCmd, writeInstaller } from "../src/installer.ts";
import { HttpError } from "../src/packages.ts";

const TOKEN = "Abc123_-xyzXYZ0987654321";

test("the installer carries the server and token and runs setup when elevated", () => {
  const text = renderInstallerCmd("192.168.1.72:7420", TOKEN, new Date(2026, 9, 16, 9, 5));
  assert.match(text, /^@echo off\r\n/);
  assert.ok(text.includes('set "ZD_SERVER=192.168.1.72:7420"\r\n'));
  assert.ok(text.includes(`set "ZD_TOKEN=${TOKEN}"\r\n`));
  assert.ok(text.includes("Made: 2026-10-16 09:05"));
  assert.ok(text.includes('if /i "%~1"=="elevated" goto elevated'));
  assert.ok(text.includes(":elevated\r\n"));
  assert.ok(text.includes('"%~dp0zeploy-agent.exe" setup --server %ZD_SERVER% --token %ZD_TOKEN%'));
  assert.ok(text.includes("-ArgumentList 'elevated' -Verb RunAs -Wait -PassThru"));
});

test("every line ends in CRLF, as cmd.exe expects", () => {
  const text = renderInstallerCmd("pc-admin:7420", TOKEN);
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(text.replace(/\r\n/g, "").includes("\r"), false);
});

// A ) or & inside an expanded path would end a ( ) block or split a line, so
// no variable that can hold a path or user name is expanded inside a block.
test("paths and user names are never expanded inside ( ) blocks", () => {
  const lines = renderInstallerCmd("192.168.1.72:7420", TOKEN).split("\r\n");
  let depth = 0;
  for (const line of lines) {
    if (depth > 0) {
      assert.doesNotMatch(line, /%~dp0|%~f0|%USERNAME%|%TEMP%|%ZD_STAGE%|%ZD_EXE%/, line);
    }
    if (/\(\s*$/.test(line)) depth++;
    if (/^\s*\)\s*$/.test(line)) depth--;
  }
  assert.equal(depth, 0);
});

test("values a .cmd file cannot hold safely are refused", () => {
  for (const server of ["192.168.1.72 & calc", "host:7420\"", "a b", "x%PATH%", ""]) {
    assert.throws(() => renderInstallerCmd(server, TOKEN), HttpError, server);
  }
  for (const token of ["short", "token%PATH%token123", "token&calc&token123", "token token token 1"]) {
    assert.throws(() => renderInstallerCmd("192.168.1.72:7420", token), HttpError, token);
  }
});

test("writeInstaller saves the .cmd next to a copy of the agent", async () => {
  const root = await makeTmp();
  const agent = join(root, "build", AGENT_EXE_NAME);
  await write(agent, "fake exe");
  const folder = join(root, "share folder (team)");
  await write(join(folder, ".keep"));

  const saved = await writeInstaller(folder, { server: "192.168.1.72:7420", token: TOKEN, agentExe: agent });
  assert.equal(saved.cmd, join(folder, INSTALLER_NAME));
  assert.equal(await readFile(saved.exe, "utf8"), "fake exe");
  assert.ok((await readFile(saved.cmd, "utf8")).includes(TOKEN));

  // Saving into the folder the agent already lives in does not copy it onto itself.
  const again = await writeInstaller(join(root, "build"), { server: "192.168.1.72:7420", token: TOKEN, agentExe: agent });
  assert.equal(await readFile(again.exe, "utf8"), "fake exe");
});

test("writeInstaller explains a missing agent build or folder", async () => {
  const root = await makeTmp();
  await assert.rejects(
    writeInstaller(root, { server: "192.168.1.72:7420", token: TOKEN, agentExe: join(root, "nope.exe") }),
    /not built yet/,
  );
  await write(join(root, AGENT_EXE_NAME), "x");
  await assert.rejects(
    writeInstaller(join(root, "missing"), { server: "192.168.1.72:7420", token: TOKEN, agentExe: join(root, AGENT_EXE_NAME) }),
    /folder not found/,
  );
});
