// Saving state.json and usage.json: a failed write must never stop later
// ones, and a file that cannot be read must never be replaced by an empty one.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTmp } from "../../core/test/helpers.ts";
import { JsonFile } from "../src/json-file.ts";
import { Store } from "../src/store.ts";

async function waitFor<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A folder where the temporary file goes makes every write fail until it is removed.
async function blockWrites(path: string): Promise<() => Promise<void>> {
  await mkdir(`${path}.tmp`);
  return () => rm(`${path}.tmp`, { recursive: true, force: true });
}

test("a failed write is logged, and the next write still saves", async () => {
  const dir = await makeTmp();
  const lines: string[] = [];
  const file = new JsonFile(join(dir, "state.json"), { log: (l) => lines.push(l), retryMs: 60_000 });
  const unblock = await blockWrites(file.path);

  await assert.rejects(file.write(() => '{"n":1}'));
  assert.match(lines.join("\n"), /could not save .*state\.json/);

  await unblock();
  await file.write(() => '{"n":2}');
  assert.equal(await readFile(file.path, "utf8"), '{"n":2}');
  assert.match(lines.at(-1)!, /saved .*state\.json again/);
  file.stop();
});

test("after a failed write, the latest data is saved again by itself", async () => {
  const dir = await makeTmp();
  let n = 1;
  const file = new JsonFile(join(dir, "state.json"), { log: () => {}, retryMs: 50 });
  const unblock = await blockWrites(file.path);
  await assert.rejects(file.write(() => JSON.stringify({ n })));

  n = 2; // changed in memory while the file could not be written
  await unblock();
  await waitFor("the retry", async () => (await readFile(file.path, "utf8").catch(() => "")) === '{"n":2}');
  file.stop();
});

test("a store keeps saving after a failed save", async () => {
  const dir = await makeTmp();
  const store = await Store.open(dir, { log: () => {}, retryMs: 60_000 });
  const unblock = await blockWrites(join(dir, "state.json"));
  store.data.packages.push({ id: "a", name: "A", version: "1.0.0", sha256: "", size: 0, file: "a.zip", addedAt: "", components: [] });
  await assert.rejects(store.flush());

  await unblock();
  store.data.packages.push({ id: "b", name: "B", version: "1.0.0", sha256: "", size: 0, file: "b.zip", addedAt: "", components: [] });
  await store.flush();
  const saved = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.deepEqual(saved.packages.map((p: { id: string }) => p.id), ["a", "b"]);
  await store.close();
});

test("a damaged state.json stops the store instead of being replaced", async () => {
  const dir = await makeTmp();
  await writeFile(join(dir, "state.json"), '{"version":1,"enrollToken":"keep');
  await assert.rejects(Store.open(dir, { log: () => {} }), /state\.json is damaged/);
  assert.equal(await readFile(join(dir, "state.json"), "utf8"), '{"version":1,"enrollToken":"keep');

  // No file at all: a new store.
  const fresh = await makeTmp();
  const store = await Store.open(fresh, { log: () => {} });
  assert.ok(store.data.enrollToken);
  await store.close();
});
