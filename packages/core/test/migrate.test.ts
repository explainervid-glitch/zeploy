import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { migrateLegacyDir } from "../src/index.ts";
import { makeTmp, write } from "./helpers.ts";

test("a folder under the old zdeploy name moves to the new one once", async () => {
  const root = await makeTmp();
  await write(join(root, "zdeploy", "receipts", "colosave.json"), "{}");
  migrateLegacyDir(join(root, "zdeploy"), join(root, "zeploy"));
  assert.equal(await readFile(join(root, "zeploy", "receipts", "colosave.json"), "utf8"), "{}");
  await assert.rejects(readFile(join(root, "zdeploy", "receipts", "colosave.json")));
});

test("an existing new folder is never overwritten by the old one", async () => {
  const root = await makeTmp();
  await write(join(root, "zdeploy", "agent.json"), "old");
  await write(join(root, "zeploy", "agent.json"), "new");
  migrateLegacyDir(join(root, "zdeploy"), join(root, "zeploy"));
  assert.equal(await readFile(join(root, "zeploy", "agent.json"), "utf8"), "new");
  assert.equal(await readFile(join(root, "zdeploy", "agent.json"), "utf8"), "old");
});

test("nothing happens when there is no old folder", async () => {
  const root = await makeTmp();
  migrateLegacyDir(join(root, "zdeploy"), join(root, "zeploy"));
  await assert.rejects(readFile(join(root, "zeploy")));
});
