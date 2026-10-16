import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeRelativePath, ManifestError, parseManifest } from "../src/index.ts";

const base = { schemaVersion: 1, id: "colosave", name: "Colosave", version: "1.2.0" };

test("parses a valid manifest and fills defaults", () => {
  const m = parseManifest({
    ...base,
    components: [
      { type: "cep", source: "cep/com.colosave.panel" },
      { type: "ae-script", source: "scripts/Tool.jsx" },
      { type: "blender", source: "addon.zip" },
    ],
  });
  const [cep, script] = m.components;
  assert.equal(cep?.type === "cep" && cep.playerDebugMode, true);
  assert.equal(script?.type === "ae-script" && script.folder, "ScriptUI Panels");
});

test("rejects bad ids, versions and empty component lists", () => {
  assert.throws(() => parseManifest({ ...base, id: "Colo Save", components: [{ type: "cep", source: "a" }] }), ManifestError);
  assert.throws(() => parseManifest({ ...base, version: "1.2", components: [{ type: "cep", source: "a" }] }), ManifestError);
  assert.throws(() => parseManifest({ ...base, components: [] }), ManifestError);
  assert.throws(() => parseManifest({ ...base, components: [{ type: "dll", source: "a" }] }), ManifestError);
});

test("rejects sources outside the package", () => {
  for (const source of ["../evil", "a/../../evil", "C:\\Windows", "/etc", "\\\\server\\share"]) {
    assert.throws(() => parseManifest({ ...base, components: [{ type: "cep", source }] }), ManifestError, source);
  }
});

test("blender source must be a .zip or .py file", () => {
  assert.throws(() => parseManifest({ ...base, components: [{ type: "blender", source: "addon_folder" }] }), ManifestError);
  parseManifest({ ...base, components: [{ type: "blender", source: "single.py" }] });
});

test("isSafeRelativePath", () => {
  assert.equal(isSafeRelativePath("cep/panel"), true);
  assert.equal(isSafeRelativePath("cep\\panel"), true);
  assert.equal(isSafeRelativePath("..foo/bar"), true);
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath("cep\\..\\..\\x"), false);
  assert.equal(isSafeRelativePath("D:relative"), false);
});
