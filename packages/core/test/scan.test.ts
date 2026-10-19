// Finding plugins on a PC that zeploy did not install.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { scanInstalled } from "../src/index.ts";
import { fakeEnv, makeTmp, write, writeCepPanel } from "./helpers.ts";

test("plugins in the install folders are found with their keys and versions", async () => {
  const root = await makeTmp();
  const blender = { version: "4.2", dir: join(root, "Blender 4.2"), exe: join(root, "Blender 4.2", "blender.exe") };
  const illustrator = {
    app: "illustrator" as const,
    version: "2025",
    dir: join(root, "Adobe Illustrator 2025"),
    exe: join(root, "Adobe Illustrator 2025", "Illustrator.exe"),
  };
  const base = fakeEnv(root, { blender: [blender] });
  const env = { ...base, adobe: [...base.adobe, illustrator] };
  const ae = env.adobe[0]!;
  await write(join(illustrator.dir, "Presets", "en_US", "Scripts", "Align.jsx"), "#target illustrator\n// @version 1.2\n");

  await writeCepPanel(join(env.cep.user, "Colosave"), "com.Colosave.panel");
  await write(join(env.cep.system, "not-a-panel", "readme.txt"), "x");
  await write(join(ae.dir, "Support Files", "Scripts", "ScriptUI Panels", "Aegroup.jsx"), "// @version 2.1\n");
  await write(join(ae.dir, "Support Files", "Scripts", "Rename.jsxbin"), "bin");
  // A "portable" folder beside blender.exe holds its user files.
  const portable = join(blender.dir, "portable");
  await write(join(portable, "scripts", "addons", "remaper", "__init__.py"), 'bl_info = {"name": "Remaper", "version": (1, 3)}\n');
  await write(join(portable, "extensions", "user_default", "figblend", "blender_manifest.toml"), 'id = "figblend"\nversion = "0.2.0"\n');

  const found = await scanInstalled(env);
  const byKey = Object.fromEntries(found.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "ae-script:aegroup.jsx",
    "ae-script:rename.jsxbin",
    "ai-script:align.jsx",
    "blender:figblend",
    "blender:remaper",
    "cep:com.colosave.panel",
  ]);
  assert.equal(byKey["cep:com.colosave.panel"]!.version, "1.0.0");
  assert.equal(byKey["cep:com.colosave.panel"]!.where, "CEP, this user");
  assert.equal(byKey["ae-script:aegroup.jsx"]!.where, "AE 2024 ScriptUI Panels");
  assert.equal(byKey["ae-script:aegroup.jsx"]!.version, "2.1.0");
  assert.equal(byKey["ae-script:rename.jsxbin"]!.version, null);
  assert.deepEqual(byKey["ai-script:align.jsx"], { key: "ai-script:align.jsx", version: "1.2.0", where: "Illustrator 2025 Scripts" });
  assert.equal(byKey["blender:remaper"]!.version, "1.3.0");
  assert.equal(byKey["blender:figblend"]!.version, "0.2.0");
});

test("a PC without any of the folders finds nothing", async () => {
  assert.deepEqual(await scanInstalled(fakeEnv(await makeTmp())), []);
});
