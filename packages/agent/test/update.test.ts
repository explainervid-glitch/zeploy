// The part of an agent update that runs before anything is replaced: a
// downloaded exe that does not start leaves the installed agent alone.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTmp, write } from "../../core/test/helpers.ts";
import { exeUpdater } from "../src/update.ts";

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
