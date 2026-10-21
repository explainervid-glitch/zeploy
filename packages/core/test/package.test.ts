import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { hasUsageHelper, openPackage, packPackage, PackageError, sha256, type Manifest } from "../src/index.ts";
import { makeTmp, write, writeCepPanel } from "./helpers.ts";

async function makePackageFolder(root: string) {
  const dir = join(root, "src");
  await write(
    join(dir, "zeploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "colosave",
      name: "Colosave",
      version: "1.0.0",
      components: [{ type: "cep", source: "cep/com.colosave.panel" }],
    }),
  );
  await writeCepPanel(join(dir, "cep", "com.colosave.panel"), "com.colosave.panel");
  await write(join(dir, "cep", "com.colosave.panel", ".git", "HEAD"), "ref");
  await write(join(dir, "README.md"), "not part of the package");
  return dir;
}

test("pack keeps only the manifest and component sources", async () => {
  const root = await makeTmp();
  const r = await packPackage(await makePackageFolder(root), join(root, "out"));

  assert.equal(r.path, join(root, "out", "colosave-1.0.0.zip"));
  const names = Object.keys(unzipSync(await readFile(r.path))).sort();
  assert.deepEqual(names, [
    "cep/com.colosave.panel/CSXS/manifest.xml",
    "cep/com.colosave.panel/index.html",
    "zeploy.json",
  ]);
  assert.equal(r.sha256, sha256(await readFile(r.path)));
});

test("opening a zip stages it locally and close() removes the staging copy", async () => {
  const root = await makeTmp();
  const { path, sha256: hash } = await packPackage(await makePackageFolder(root), join(root, "out"));

  const pkg = await openPackage(path, { stagingRoot: join(root, "staging"), expectedSha256: hash.toUpperCase() });
  assert.equal(pkg.manifest.id, "colosave");
  assert.equal(pkg.archive?.sha256, hash);
  assert.ok(await stat(join(pkg.root, "cep", "com.colosave.panel", "CSXS", "manifest.xml")));
  await pkg.close();
  assert.deepEqual(await readdir(join(root, "staging")), []);
});

test("a wrong SHA-256 is refused before anything is extracted", async () => {
  const root = await makeTmp();
  const { path } = await packPackage(await makePackageFolder(root), join(root, "out"));
  await assert.rejects(
    openPackage(path, { stagingRoot: join(root, "staging"), expectedSha256: "00".repeat(32) }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(join(root, "staging")));
});

test("a zip with a path escaping the staging folder extracts nothing", async () => {
  const root = await makeTmp();
  const zip = join(root, "evil.zip");
  await writeFile(
    zip,
    zipSync({
      "zeploy.json": strToU8("{}"),
      "../escaped.txt": strToU8("x"),
    }),
  );
  await assert.rejects(openPackage(zip, { stagingRoot: join(root, "staging") }), PackageError);
  await assert.rejects(stat(join(root, "escaped.txt")));
  await assert.rejects(stat(join(root, "staging", "escaped.txt")));
});

test("a component source missing from the package is reported", async () => {
  const root = await makeTmp();
  await write(
    join(root, "zeploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "x",
      name: "X",
      version: "1.0.0",
      components: [{ type: "cep", source: "missing" }],
    }),
  );
  await assert.rejects(openPackage(root, { stagingRoot: join(root, "staging") }), /source not found/);
});

test("the usage helper is found in a panel's scripts, a Blender add-on zip and a .zxp", async () => {
  const root = await makeTmp();
  const manifest = (type: string, source: string) =>
    ({ schemaVersion: 1, id: "x", name: "X", version: "1.0.0", components: [{ type, source }] }) as Manifest;

  await writeCepPanel(join(root, "plain"), "com.plain.panel");
  assert.equal(await hasUsageHelper(root, manifest("cep", "plain")), false);

  await writeCepPanel(join(root, "panel"), "com.counted.panel");
  await write(join(root, "panel", "js", "zeploy-usage.js"), "function zeployUsageV1(id, version, app) {}");
  assert.equal(await hasUsageHelper(root, manifest("cep", "panel")), true);

  await write(join(root, "addon.zip"), zipSync({ "addon/__init__.py": strToU8("from . import zeploy_usage\nzeployUsageV1 = 1") }));
  assert.equal(await hasUsageHelper(root, manifest("blender", "addon.zip")), true);

  await write(join(root, "plain.zxp"), zipSync({ "index.html": strToU8("<html></html>") }));
  assert.equal(await hasUsageHelper(root, manifest("zxp", "plain.zxp")), false);
});
