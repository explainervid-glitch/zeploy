import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { detectEnvironment, installPackage, listReceipts, packPackage, uninstallPackage } from "../src/index.ts";
import { collectLog, fakeEnv, makeTmp, noProcesses, write, writeCepPanel } from "./helpers.ts";

async function writePackage(dir: string, version: string, installName: string) {
  await write(
    join(dir, "zeploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "colosave",
      name: "Colosave",
      version,
      components: [{ type: "cep", source: "panel", installName }],
    }),
  );
  await writeCepPanel(join(dir, "panel"), "com.colosave.panel");
}

test("install, upgrade and uninstall a zip package end to end", async () => {
  const root = await makeTmp();
  const env = fakeEnv(root);
  const { log } = collectLog();
  const run = { dryRun: false, ifRunning: "fail" as const, log, processes: noProcesses, plan: { skipRegistry: true } };

  await writePackage(join(root, "v1"), "1.0.0", "Colosave");
  const v1 = await packPackage(join(root, "v1"), join(root, "out"));
  const r1 = await installPackage(v1.path, env, { ...run, expectedSha256: v1.sha256 });
  assert.equal(r1.receipt?.sha256, v1.sha256);
  assert.ok(await stat(join(env.cep.user, "Colosave", "index.html")));
  await assert.rejects(stat(join(env.cep.user, "Colosave", ".debug")));

  // v2 installs under another folder name; the v1 folder must go.
  await writePackage(join(root, "v2"), "2.0.0", "com.colosave.panel");
  const v2 = await packPackage(join(root, "v2"), join(root, "out"));
  const r2 = await installPackage(v2.path, env, run);
  assert.equal(r2.previous?.version, "1.0.0");
  assert.deepEqual(await readdir(env.cep.user), ["com.colosave.panel"]);
  assert.deepEqual(
    (await listReceipts(env)).map((r) => `${r.id}@${r.version}`),
    ["colosave@2.0.0"],
  );

  await uninstallPackage("colosave", env, run);
  assert.deepEqual(await readdir(env.cep.user), []);
  assert.deepEqual(await listReceipts(env), []);
  // Staging copies of the zips are cleaned up.
  assert.deepEqual(await readdir(join(env.home, "staging")), []);
});

test("a dry run writes no files and no receipt", async () => {
  const root = await makeTmp();
  const env = fakeEnv(root);
  await writePackage(join(root, "pkg"), "1.0.0", "Colosave");
  const { lines, log } = collectLog();

  await installPackage(join(root, "pkg"), env, { dryRun: true, ifRunning: "fail", log, processes: noProcesses });
  await assert.rejects(stat(env.cep.user));
  assert.deepEqual(await listReceipts(env), []);
  assert.match(lines.join("\n"), /would copy folder/);
  assert.match(lines.join("\n"), /would set PlayerDebugMode=1/);
});

test("detectEnvironment finds apps in a fake Program Files tree", async () => {
  const root = await makeTmp();
  const pf = join(root, "PF");
  await write(join(pf, "Adobe", "Adobe After Effects 2025", "Support Files", "AfterFX.exe"));
  await write(join(pf, "Adobe", "Adobe Premiere Pro 2025", "Adobe Premiere Pro.exe"));
  await write(join(pf, "Adobe", "Adobe Photoshop 2025", "Photoshop.exe"));
  await write(join(pf, "Blender Foundation", "Blender 4.2", "blender.exe"));
  await write(join(pf, "Blender Foundation", "Blender 4.2", "4.2", "scripts", ".keep"));
  await write(join(pf, "Blender Foundation", "Broken", "readme.txt"));
  await write(join(root, "Local", "Adobe", "Animate 2024", "en_US", "Configuration", "Commands", ".keep"));

  const env = await detectEnvironment({
    isAdmin: false,
    home: join(root, "home"),
    paths: {
      programFiles: pf,
      programFilesX86: join(root, "PF86"),
      commonFiles: join(pf, "Common Files"),
      commonFilesX86: join(root, "PF86", "Common Files"),
      appData: join(root, "Roaming"),
      localAppData: join(root, "Local"),
    },
  });
  assert.deepEqual(
    env.adobe.map((a) => `${a.app} ${a.version}`),
    ["aftereffects 2025", "premiere 2025"],
  );
  assert.deepEqual(env.blender.map((b) => b.version), ["4.2"]);
  assert.deepEqual(env.animateConfigs.map((c) => `${c.version} ${c.lang}`), ["2024 en_US"]);
  assert.equal(env.upia, null);
});
