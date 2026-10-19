// Packages without zeploy.json: what zeploy reads from the plugin's own files.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  buildInferredPackage,
  hasManifest,
  inferPlugin,
  inspectBlenderSource,
  normalizeVersion,
  openPackage,
  packageKeys,
  packPackage,
  parseBlInfo,
  parseManifest,
  retargetScript,
  scriptVersion,
  type InferredPlugin,
} from "../src/index.ts";
import { blenderExtensionZip, makeTmp, write, writeCepPanel } from "./helpers.ts";

const manifestFor = (p: InferredPlugin, version = p.version) =>
  parseManifest({ schemaVersion: 1, id: p.id, name: p.name, version, components: [p.component] });

async function cepPanel(dir: string, xmlAttrs: string, menu = "") {
  await write(
    join(dir, "CSXS", "manifest.xml"),
    `<?xml version="1.0"?>\n<ExtensionManifest Version="7.0" ${xmlAttrs}><ExecutionEnvironment><HostList>` +
      `<Host Name="AEFT" Version="[18.0,99.9]" /><Host Name="PPRO" Version="[18.0,99.9]" /></HostList>` +
      `</ExecutionEnvironment><DispatchInfoList><Extension Id="x"><DispatchInfo><UI>` +
      `${menu ? `<Menu>${menu}</Menu>` : ""}</UI></DispatchInfo></Extension></DispatchInfoList></ExtensionManifest>`,
  );
  await write(join(dir, "index.html"), "<html></html>");
}

test("versions are normalised to major.minor.patch", () => {
  assert.equal(normalizeVersion("1.2"), "1.2.0");
  assert.equal(normalizeVersion("v2.0.1.7"), "2.0.1");
  assert.equal(normalizeVersion("beta"), null);
  assert.equal(scriptVersion('// @version 1.4\nvar x = 1;'), "1.4.0");
  assert.equal(scriptVersion('var SCRIPT_VERSION = "2.1.3";'), "2.1.3");
  assert.equal(scriptVersion("alert('hi')"), null);
  assert.deepEqual(parseBlInfo('bl_info = {"name": "Remaper", "version": (1, 3), "blender": (4, 2, 0)}'), {
    name: "Remaper",
    version: "1.3.0",
  });
});

test("a CEP panel folder: id, name, version and apps from CSXS/manifest.xml", async () => {
  const root = await makeTmp();
  const dir = join(root, "Colosave Panel");
  await cepPanel(dir, 'ExtensionBundleId="com.Colosave.panel" ExtensionBundleVersion="1.4"', "Colosave");

  const p = await inferPlugin(dir);
  assert.equal(p.from, "CSXS/manifest.xml");
  assert.equal(p.key, "cep:com.colosave.panel");
  assert.equal(p.id, "com.colosave.panel");
  assert.equal(p.name, "Colosave");
  assert.equal(p.version, "1.4.0");
  assert.deepEqual(p.apps.sort(), ["aftereffects", "premiere"]);
  assert.deepEqual(p.component, { type: "cep", source: "Colosave Panel", playerDebugMode: true });
  assert.equal(await hasManifest(dir), false);
});

test("a folder holding one plugin is that plugin; several need a choice", async () => {
  const root = await makeTmp();
  await writeCepPanel(join(root, "repo", "cep", "com.audimate.panel"), "com.audimate.panel");
  await write(join(root, "repo", "README.md"), "docs");
  // One level down only: cep/com.audimate.panel is two levels down.
  await assert.rejects(inferPlugin(join(root, "repo")), /holds no plugin/);

  const p = await inferPlugin(join(root, "repo", "cep"));
  assert.equal(p.id, "com.audimate.panel");

  await write(join(root, "repo", "cep", "Tool.jsx"), "alert(1)");
  await assert.rejects(inferPlugin(join(root, "repo", "cep")), /holds 2 plugins \(com\.audimate\.panel, Tool\.jsx\)/);
});

test("scripts: ScriptUI panels, plain scripts and JSFL commands", async () => {
  const root = await makeTmp();
  await write(join(root, "Aegroup.jsx"), '// @version 2.0\n(function (thisObj) { var w = thisObj instanceof Panel ? thisObj : new Window("palette"); })(this);');
  await write(join(root, "Rename Layers.jsx"), "app.project.activeItem;");
  await write(join(root, "DelayerZ.jsfl"), 'var version = "1.1.0";');

  const panel = await inferPlugin(join(root, "Aegroup.jsx"));
  assert.deepEqual(panel.component, { type: "ae-script", source: "Aegroup.jsx", folder: "ScriptUI Panels" });
  assert.equal(panel.version, "2.0.0");
  assert.equal(panel.from, "the script");

  const script = await inferPlugin(join(root, "Rename Layers.jsx"));
  assert.deepEqual(script.component, { type: "ae-script", source: "Rename Layers.jsx", folder: "Scripts" });
  assert.equal(script.id, "rename-layers");
  assert.equal(script.version, null, "the admin enters it");

  const jsfl = await inferPlugin(join(root, "DelayerZ.jsfl"));
  assert.deepEqual(jsfl.component, { type: "jsfl", source: "DelayerZ.jsfl", folder: "Commands" });
  assert.deepEqual(jsfl.apps, ["animate"]);
});

test("Blender: extension zip, legacy add-on folder and single-file add-on", async () => {
  const root = await makeTmp();
  await write(join(root, "figblend-0.2.0.zip"), blenderExtensionZip("figblend"));
  const ext = await inferPlugin(join(root, "figblend-0.2.0.zip"));
  assert.equal(ext.from, "blender_manifest.toml");
  assert.equal(ext.key, "blender:figblend");
  assert.equal(ext.version, "1.0.0");
  assert.deepEqual(ext.component, { type: "blender", source: "figblend-0.2.0.zip" });

  const addon = join(root, "src", "remaper");
  await write(join(addon, "__init__.py"), 'bl_info = {\n    "name": "Remaper",\n    "version": (1, 3, 2),\n}\n');
  await write(join(addon, "ops.py"), "pass");
  await write(join(addon, "__pycache__", "ops.cpython-311.pyc"), "junk");
  const legacy = await inferPlugin(addon);
  assert.equal(legacy.name, "Remaper");
  assert.equal(legacy.version, "1.3.2");
  assert.deepEqual(legacy.component, { type: "blender", source: "remaper.zip" });

  // Built into a package, the folder becomes an add-on zip Blender accepts.
  const pkg = join(root, "built");
  await buildInferredPackage(legacy, manifestFor(legacy), pkg);
  const info = await inspectBlenderSource(join(pkg, "remaper.zip"));
  assert.deepEqual([info.kind, info.module], ["addon", "remaper"]);

  await write(join(root, "quick_tool.py"), 'bl_info = {"name": "Quick Tool", "version": (0, 9)}\n');
  const single = await inferPlugin(join(root, "quick_tool.py"));
  assert.deepEqual([single.id, single.name, single.version], ["quick_tool", "Quick Tool", "0.9.0"]);
});

test("zxp and ccx: details and the extension name from their manifests", async () => {
  const root = await makeTmp();
  const xml =
    '<ExtensionManifest ExtensionBundleId="com.motion.tools" ExtensionBundleVersion="3.1.0" ExtensionBundleName="Motion Tools">' +
    '<HostList><Host Name="AEFT" Version="[18.0,99.9]" /></HostList></ExtensionManifest>';
  await write(join(root, "MotionTools.zxp"), zipSync({ "CSXS/manifest.xml": strToU8(xml), "index.html": strToU8("") }));
  const zxp = await inferPlugin(join(root, "MotionTools.zxp"));
  assert.deepEqual([zxp.id, zxp.name, zxp.version, zxp.extensionName], ["com.motion.tools", "Motion Tools", "3.1.0", "Motion Tools"]);
  assert.deepEqual(zxp.component, { type: "zxp", source: "MotionTools.zxp", extensionName: "Motion Tools" });

  const uxp = { id: "com.team.ppro", name: "Team Panel", version: "1.0.4", host: { app: "PPRO", minVersion: "25.0" } };
  await write(join(root, "TeamPanel.ccx"), zipSync({ "manifest.json": strToU8(JSON.stringify(uxp)) }));
  const ccx = await inferPlugin(join(root, "TeamPanel.ccx"));
  assert.deepEqual([ccx.id, ccx.name, ccx.version, ccx.extensionName], ["com.team.ppro", "Team Panel", "1.0.4", "Team Panel"]);
  assert.deepEqual(ccx.apps, ["premiere"]);
});

test("a zipped CEP panel is extracted into the package", async () => {
  const root = await makeTmp();
  const xml = '<ExtensionManifest ExtensionBundleId="com.zip.panel" ExtensionBundleVersion="1.0.0"><Host Name="AEFT" /></ExtensionManifest>';
  await write(
    join(root, "panel.zip"),
    zipSync({ "ZipPanel/CSXS/manifest.xml": strToU8(xml), "ZipPanel/js/main.js": strToU8("1") }),
  );
  const p = await inferPlugin(join(root, "panel.zip"));
  assert.deepEqual(p.component, { type: "cep", source: "ZipPanel", playerDebugMode: true });

  const pkg = join(root, "built");
  await buildInferredPackage(p, manifestFor(p), pkg);
  const opened = await openPackage(pkg, { stagingRoot: join(root, "staging") });
  assert.equal(opened.manifest.id, "com.zip.panel");
  assert.deepEqual(await packageKeys(pkg, opened.manifest), ["cep:com.zip.panel"]);
});

test("the same plugin always packs to the same bytes", async () => {
  const root = await makeTmp();
  const dir = join(root, "panel");
  await cepPanel(dir, 'ExtensionBundleId="com.same.panel" ExtensionBundleVersion="1.0.0"');
  const p = await inferPlugin(dir);
  const shas: string[] = [];
  for (const n of [1, 2]) {
    await buildInferredPackage(p, manifestFor(p), join(root, `build${n}`));
    await new Promise((r) => setTimeout(r, 1100));
    shas.push((await packPackage(join(root, `build${n}`), join(root, `out${n}`))).sha256);
  }
  assert.equal(shas[0], shas[1]);
});

test("a folder or zip with zeploy.json is an ordinary package", async () => {
  const root = await makeTmp();
  await write(join(root, "pkg", "zeploy.json"), "{}");
  await write(join(root, "pkg.zip"), zipSync({ "zeploy.json": strToU8("{}") }));
  await write(join(root, "plain.zip"), blenderExtensionZip("x"));
  assert.equal(await hasManifest(join(root, "pkg")), true);
  assert.equal(await hasManifest(join(root, "pkg.zip")), true);
  assert.equal(await hasManifest(join(root, "plain.zip")), false);
});

test("something that is no plugin says what zeploy expects", async () => {
  const root = await makeTmp();
  await write(join(root, "notes.txt"), "hi");
  await assert.rejects(inferPlugin(join(root, "notes.txt")), /not a plugin zeploy recognises/);
  await assert.rejects(inferPlugin(join(root, "missing")), /not found/);
});

test("a .jsx targeting Illustrator becomes an Illustrator script, and can be pointed back", async () => {
  const root = await makeTmp();
  await write(join(root, "Align.jsx"), "#target illustrator\nvar doc = app.activeDocument;");
  await write(join(root, "Paths.jsx"), "var items = app.activeDocument.pathItems;");
  await write(join(root, "Comp.jsx"), "//@target aftereffects\nvar items = app.activeDocument.pathItems;");
  await write(join(root, "Mixed.jsx"), "app.project.activeItem; var p = pathItems;");

  const align = await inferPlugin(join(root, "Align.jsx"));
  assert.deepEqual(align.component, { type: "ai-script", source: "Align.jsx" });
  assert.deepEqual(align.apps, ["illustrator"]);
  assert.equal(align.key, "ai-script:align.jsx");
  assert.equal((await inferPlugin(join(root, "Paths.jsx"))).component.type, "ai-script");
  assert.equal((await inferPlugin(join(root, "Comp.jsx"))).component.type, "ae-script");
  assert.equal((await inferPlugin(join(root, "Mixed.jsx"))).component.type, "ae-script");

  const back = retargetScript(align, "aftereffects");
  assert.deepEqual(back.component, { type: "ae-script", source: "Align.jsx", folder: "Scripts" });
  assert.equal(back.key, "ae-script:align.jsx");
  assert.deepEqual(retargetScript(back, "illustrator").component, align.component);
});
