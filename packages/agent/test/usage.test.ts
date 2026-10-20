// Plugin usage: what plugins write (through the helpers in examples/usage)
// is what the agent reads.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { UsageRow } from "../../protocol/src/index.ts";
import { makeTmp, write } from "../../core/test/helpers.ts";
import { countLines, takeSpool } from "../src/usage.ts";

const helpers = fileURLToPath(new URL("../../../examples/usage/", import.meta.url));
const NOW = new Date("2026-10-20T10:00:00Z");

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, t: "2026-10-20T09:00:00.000Z", plugin: "com.test.panel", ...fields });
}

test("lines are counted per day and plugin; anything unreadable is skipped", () => {
  const rows = new Map<string, UsageRow>();
  countLines(
    [
      line({ ev: "open", ver: "1.0.0", app: "aftereffects" }),
      line({ ev: "action", name: "export", ms: 300, ver: "1.0.0", app: "aftereffects" }),
      line({ ev: "action", name: "export", ms: 100, ver: "1.1.0", app: "aftereffects" }),
      line({ ev: "action", name: "a/b<c>", app: "aftereffects" }),
      line({ ev: "action", app: "aftereffects" }),
      line({ ev: "error", name: "export", app: "aftereffects" }),
      line({ ev: "open", plugin: "COM.TEST.PANEL", app: "aftereffects", t: "2026-10-20T09:30:00.000Z" }),
      "not json",
      line({ v: 2, ev: "open" }),
      line({ ev: "launch" }),
      line({ ev: "open", t: "1999-01-01T00:00:00Z" }),
      "",
    ],
    rows,
    NOW,
  );
  assert.equal(rows.size, 1);
  const [row] = [...rows.values()];
  assert.equal(row!.opens, 2);
  assert.deepEqual(row!.actions, { export: { n: 2, ms: 400 }, "a_b_c_": { n: 1, ms: 0 }, use: { n: 1, ms: 0 } });
  assert.deepEqual(row!.errors, { export: 1 });
  assert.deepEqual(row!.versions, { "1.0.0": 2, "1.1.0": 1 });
  assert.equal(row!.app, "aftereffects");
  assert.equal(row!.last, "2026-10-20T09:30:00.000Z");
});

test("the spool is renamed before reading, and files no admin confirmed are read again", async () => {
  const dir = await makeTmp();
  await write(join(dir, "com.test.panel.jsonl"), line({ ev: "open" }) + "\n");
  await write(join(dir, "remaper.jsonl.1.sending"), line({ plugin: "remaper", ev: "action", name: "remap" }) + "\n");
  const spool = await takeSpool(dir, NOW);
  assert.equal(spool.rows.length, 2);
  assert.equal(spool.files.length, 2);
  assert.ok((await readdir(dir)).every((n) => n.endsWith(".sending")));
});

// ---- the helpers -------------------------------------------------------------------------------

async function readUsage(base: string): Promise<Map<string, UsageRow>> {
  const dir = join(base, "zeploy", "usage");
  const rows = new Map<string, UsageRow>();
  for (const name of await readdir(dir)) countLines((await readFile(join(dir, name), "utf8")).split("\n"), rows, new Date());
  return rows;
}

function expectHelperRows(rows: Map<string, UsageRow>, plugin: string, app: string, opens: number): void {
  const row = [...rows.values()].find((r) => r.plugin === plugin);
  assert.ok(row, `a row for ${plugin}`);
  assert.equal(row.app, app);
  assert.equal(row.opens, opens);
  assert.equal(row.actions["export"]?.n, 2, "action() and track()");
  assert.equal(row.actions["\u00ebxport".replace(/[^A-Za-z0-9._ -]/g, "_")]?.n, 1, "a name outside ASCII");
  assert.deepEqual(row.errors, { export: 1 });
  assert.deepEqual(row.versions, { "1.4.0": opens + 4 });
}

// Uses every call the helpers offer, the same way in each language.
const SCRIPT_CALLS = `
  u.action("export");
  u.track("export", function () { return 1; });
  u.action("\\u00ebxport");
  try { u.track("export", function () { throw new Error("boom"); }); } catch (e) {}
`;

test("the CEP panel helper (with Node) writes lines the agent reads", async () => {
  const base = await makeTmp();
  mkdirSync(join(base, "zeploy"));
  const window: Record<string, any> = {};
  const context = vm.createContext({ window, require: createRequire(import.meta.url), process: { env: { LOCALAPPDATA: base } } });
  vm.runInContext(await readFile(join(helpers, "zeploy-usage.js"), "utf8"), context);
  context["u"] = window["zeployUsageV1"]("com.colosave.panel", "1.4.0", "aftereffects");
  vm.runInContext(`u.open();${SCRIPT_CALLS}`, context);
  expectHelperRows(await readUsage(base), "com.colosave.panel", "aftereffects", 1);
});

test("the ExtendScript helper writes lines the agent reads, and nothing without zeploy", async () => {
  const run = (base: string) => {
    // Just enough of ExtendScript's $, Folder and File.
    class Folder {
      fsName: string;
      constructor(path: string) {
        this.fsName = path;
      }
      get exists() {
        return existsSync(this.fsName);
      }
      create() {
        mkdirSync(this.fsName, { recursive: true });
        return true;
      }
    }
    class File extends Folder {
      encoding = "";
      lineFeed = "";
      get length() {
        return statSync(this.fsName).size;
      }
      open() {
        return true;
      }
      writeln(text: string) {
        appendFileSync(this.fsName, text + (this.lineFeed === "Unix" ? "\n" : "\r\n"));
      }
      close() {}
    }
    const sandbox: Record<string, unknown> = { Folder, File };
    sandbox["$"] = { global: sandbox, getenv: (k: string) => (k === "LOCALAPPDATA" ? base : "") };
    const context = vm.createContext(sandbox);
    return readFile(join(helpers, "zeploy-usage.jsx"), "utf8").then((code) => {
      vm.runInContext(code, context);
      vm.runInContext(`var u = zeployUsageV1("Aegroup.jsx", "1.4.0", "aftereffects"); u.open(); u.open();${SCRIPT_CALLS}`, context);
    });
  };
  const base = await makeTmp();
  mkdirSync(join(base, "zeploy"));
  await run(base);
  expectHelperRows(await readUsage(base), "Aegroup.jsx", "aftereffects", 2);

  const without = await makeTmp();
  await run(without);
  assert.deepEqual(readdirSync(without), [], "no zeploy folder, nothing written");
});

test("the JSFL helper writes lines the agent reads", async () => {
  const base = await makeTmp();
  mkdirSync(join(base, "zeploy"));
  const toPath = (uri: string) => uri.replace(/^file:\/\/\//, "");
  const context = vm.createContext({
    fl: { configURI: `file:///${base.replace(/\\/g, "/")}/Adobe/Animate 2024/en_US/Configuration/` },
    FLfile: {
      exists: (uri: string) => existsSync(toPath(uri)),
      createFolder: (uri: string) => (mkdirSync(toPath(uri), { recursive: true }), true),
      getSize: (uri: string) => statSync(toPath(uri)).size,
      write: (uri: string, text: string) => (appendFileSync(toPath(uri), text), true),
    },
  });
  vm.runInContext(await readFile(join(helpers, "zeploy-usage.jsfl"), "utf8"), context);
  vm.runInContext(`var u = zeployUsageV1("DelayerZ.jsfl", "1.4.0");${SCRIPT_CALLS}`, context);
  expectHelperRows(await readUsage(base), "DelayerZ.jsfl", "animate", 0);
});

// Blender's own Python, when a Blender is installed (or ZEPLOY_TEST_PYTHON).
function findPython(): string | null {
  if (process.env["ZEPLOY_TEST_PYTHON"]) return process.env["ZEPLOY_TEST_PYTHON"];
  const foundation = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Blender Foundation");
  for (const blender of existsSync(foundation) ? readdirSync(foundation) : []) {
    for (const version of readdirSync(join(foundation, blender)).filter((n) => /^\d+\.\d+$/.test(n))) {
      const exe = join(foundation, blender, version, "python", "bin", "python.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

test("the Blender helper writes lines the agent reads", async (t) => {
  const python = findPython();
  if (!python) return t.skip("no Python found (set ZEPLOY_TEST_PYTHON)");
  const base = await makeTmp();
  mkdirSync(join(base, "zeploy"));
  const script = join(base, "run.py");
  await writeFile(
    script,
    [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(helpers)})`,
      "import zeploy_usage",
      "u = zeploy_usage.Usage('remaper', '1.4.0')",
      "u.open()",
      "u.action('export')",
      "@u.track('export')",
      "def ok(): return {'FINISHED'}",
      "@u.track('export')",
      "def cancelled(): return {'CANCELLED'}",
      "@u.track('export')",
      "def boom(): raise ValueError('boom')",
      "ok(); cancelled()",
      "u.action('\\u00ebxport')",
      "try:\n    boom()\nexcept ValueError:\n    pass",
    ].join("\n"),
  );
  execFileSync(python, ["-I", script], { env: { ...process.env, LOCALAPPDATA: base } });
  expectHelperRows(await readUsage(base), "remaper", "blender", 1);
});

test("the prompt for plugin projects carries the helpers as they are", async () => {
  const prompt = (await readFile(join(helpers, "..", "..", "docs", "plugin-usage-prompt.md"), "utf8")).replace(/\r\n/g, "\n");
  for (const name of ["zeploy-usage.js", "zeploy-usage.jsx", "zeploy-usage.jsfl", "zeploy_usage.py"]) {
    const code = (await readFile(join(helpers, name), "utf8")).replace(/\r\n/g, "\n").trimEnd();
    assert.ok(prompt.includes(code), `docs/plugin-usage-prompt.md has an old copy of ${name}`);
  }
});
