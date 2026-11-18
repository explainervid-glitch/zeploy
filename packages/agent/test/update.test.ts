// The part of an agent update that runs before anything is replaced: a
// downloaded exe that does not start leaves the installed agent alone.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTmp, write } from "../../core/test/helpers.ts";
import { clearOldExe, exeUpdater, removeUpdateFiles } from "../src/update.ts";

test("an exe that does not start is refused and the installed one stays", async () => {
  const root = await makeTmp();
  const exe = join(root, "zeploy", "zeploy-agent.exe");
  await write(exe, "installed agent");
  const download = join(root, "downloads", "zeploy-agent-9.0.0.exe");
  await write(download, "not a program");

  const updater = exeUpdater({ exe, pidFile: join(root, "agent.pid"), takeoverMs: 1000 });
  await assert.rejects(updater.replace(download, "9.0.0", () => {}), /did not report version 9\.0\.0/);

  assert.equal(await readFile(exe, "utf8"), "installed agent");
  assert.deepEqual(await readdir(join(root, "zeploy")), ["zeploy-agent.exe"]);
});

test("a leftover old exe that is still running is moved aside, then deleted once it stops", async () => {
  const root = await makeTmp();
  const dir = join(root, "zeploy");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "zeploy-agent.old.exe");
  // Any running program locks its exe the way a running agent or waker does.
  await copyFile(join(process.env["SystemRoot"] ?? "C:\Windows", "System32", "ping.exe"), old);
  const child = spawn(old, ["-n", "30", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
  try {
    await assert.rejects(rm(old, { force: true }), { code: "EPERM" });
    const lines: string[] = [];
    await clearOldExe(old, (l) => lines.push(l));
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^zeploy-agent\.old-\d+\.exe$/);
    assert.match(lines.join("\n"), /still in use \(EPERM\)/);
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
  await write(join(dir, "zeploy-agent.new.exe"), "half an update");
  await write(join(dir, "zeploy-agent.exe"), "installed agent");
  // A stopped process holds its exe for a moment.
  for (let i = 0; i < 40 && (await readdir(dir)).length > 1; i++) {
    await removeUpdateFiles(dir);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual(await readdir(dir), ["zeploy-agent.exe"]);
});
