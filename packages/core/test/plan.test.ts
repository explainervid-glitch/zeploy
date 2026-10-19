import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  CSXS_VERSIONS,
  DEFAULT_PLAN_OPTIONS,
  parseManifest,
  planInstall,
  PlanError,
  type Component,
  type Environment,
  type PlanOptions,
  type Receipt,
} from "../src/index.ts";
import { blenderExtensionZip, fakeEnv, legacyAddonZip, makeTmp, writeCepPanel } from "./helpers.ts";

function ctx(root: string, env: Environment, components: Component[], options: Partial<PlanOptions> = {}) {
  const manifest = parseManifest({ schemaVersion: 1, id: "pkg", name: "Pkg", version: "2.0.0", components });
  return { root, manifest, env, options: { ...DEFAULT_PLAN_OPTIONS, ...options } };
}

async function cepFixture() {
  const root = await makeTmp();
  const pkgRoot = join(root, "pkg");
  await writeCepPanel(join(pkgRoot, "panel"), "com.test.panel", ["AEFT", "PPRO"]);
  const env = fakeEnv(root);
  return { root, pkgRoot, env };
}

const cep = { type: "cep", source: "panel", playerDebugMode: true } as const;

test("cep: non-elevated auto scope goes to the per-user folder", async () => {
  const { pkgRoot, env } = await cepFixture();
  const plan = await planInstall(ctx(pkgRoot, env, [cep]));

  assert.deepEqual(plan.apps, ["aftereffects", "premiere"]);
  assert.equal(plan.actions[0]?.kind, "ensureNotRunning");
  const copy = plan.actions.find((a) => a.kind === "replaceDir");
  assert.deepEqual(copy, {
    kind: "replaceDir",
    from: join(pkgRoot, "panel"),
    to: join(env.cep.user, "com.test.panel"),
    exclude: [".debug"],
  });
  assert.equal(plan.actions.filter((a) => a.kind === "setRegistry").length, CSXS_VERSIONS.length);
  assert.deepEqual(plan.items, [{ kind: "path", path: join(env.cep.user, "com.test.panel") }]);
});

test("cep: installName overrides the bundle id as folder name", async () => {
  const { pkgRoot, env } = await cepFixture();
  const plan = await planInstall(ctx(pkgRoot, env, [{ ...cep, installName: "AudiMate" }]));
  assert.deepEqual(plan.items, [{ kind: "path", path: join(env.cep.user, "AudiMate") }]);
});

test("cep: system scope needs an elevated process", async () => {
  const { pkgRoot, env } = await cepFixture();
  await assert.rejects(planInstall(ctx(pkgRoot, env, [cep], { scope: "system" })), PlanError);
  const plan = await planInstall(ctx(pkgRoot, { ...env, isAdmin: true }, [cep]));
  assert.deepEqual(plan.items, [{ kind: "path", path: join(env.cep.system, "com.test.panel") }]);
});

test("cep: a developer link at the destination stops the install unless replacing is allowed", async () => {
  const { root, pkgRoot, env } = await cepFixture();
  const working = join(root, "working-copy");
  await mkdir(working, { recursive: true });
  await mkdir(env.cep.user, { recursive: true });
  await symlink(working, join(env.cep.user, "com.test.panel"), "junction");

  await assert.rejects(planInstall(ctx(pkgRoot, env, [cep])), /developer link/);
  const plan = await planInstall(ctx(pkgRoot, env, [cep], { replaceDevLinks: true }));
  assert.ok(plan.actions.some((a) => a.kind === "replaceDir"));
});

test("cep: a real copy in the other folder is removed, a developer link there is only reported", async () => {
  const { root, pkgRoot, env } = await cepFixture();
  const otherCopy = join(env.cep.system, "com.test.panel");
  await mkdir(otherCopy, { recursive: true });
  let plan = await planInstall(ctx(pkgRoot, env, [cep]));
  assert.ok(plan.actions.some((a) => a.kind === "removePath" && a.path === otherCopy));

  const working = join(root, "working-copy");
  await mkdir(working, { recursive: true });
  const { rm } = await import("node:fs/promises");
  await rm(otherCopy, { recursive: true });
  await symlink(working, otherCopy, "junction");
  plan = await planInstall(ctx(pkgRoot, env, [cep]));
  assert.ok(!plan.actions.some((a) => a.kind === "removePath"));
  assert.match(plan.warnings.join("\n"), /developer link left in place/);
});

test("cep: --skip-registry leaves PlayerDebugMode alone and says so", async () => {
  const { pkgRoot, env } = await cepFixture();
  const plan = await planInstall(ctx(pkgRoot, env, [cep], { skipRegistry: true }));
  assert.ok(!plan.actions.some((a) => a.kind === "setRegistry"));
  assert.match(plan.warnings.join("\n"), /PlayerDebugMode not set/);
});

function blenderEnv(root: string, versions: string[]): Environment {
  return fakeEnv(root, {
    blender: versions.map((version) => ({
      version,
      dir: join(root, `Blender ${version}`),
      exe: join(root, `Blender ${version}`, "blender.exe"),
    })),
  });
}

test("blender: an extension goes into every version inside its range", async () => {
  const root = await makeTmp();
  await writeFile(join(root, "ext.zip"), blenderExtensionZip("my_ext", "4.2.0", "5.1.0"));
  const env = blenderEnv(root, ["4.1", "4.2", "4.5", "5.0", "5.1"]);
  const plan = await planInstall(ctx(root, env, [{ type: "blender", source: "ext.zip" }]));

  const execs = plan.actions.filter((a) => a.kind === "exec");
  assert.deepEqual(
    execs.map((a) => a.label),
    ["Blender 4.2: install extension my_ext", "Blender 4.5: install extension my_ext", "Blender 5.0: install extension my_ext"],
  );
  assert.deepEqual(execs[0]?.kind === "exec" && execs[0].args.slice(0, 7), [
    "--command",
    "extension",
    "install-file",
    "--repo",
    "user_default",
    "--enable",
    join(root, "ext.zip"),
  ]);
  assert.match(plan.warnings.join("\n"), /skipped Blender 4\.1, 5\.1/);
});

test("blender: a legacy add-on is installed through Python and --blender narrows the versions", async () => {
  const root = await makeTmp();
  await writeFile(join(root, "addon.zip"), legacyAddonZip("auto_rig_pro-master"));
  const env = blenderEnv(root, ["4.2", "5.2"]);
  const plan = await planInstall(ctx(root, env, [{ type: "blender", source: "addon.zip" }], { blenderVersions: ["5.2"] }));

  assert.deepEqual(plan.items, [
    { kind: "blender-addon", exe: join(root, "Blender 5.2", "blender.exe"), version: "5.2", module: "auto_rig_pro-master", part: "Blender 5.2" },
  ]);
  const exec = plan.actions.find((a) => a.kind === "exec");
  assert.ok(exec?.kind === "exec" && exec.args.includes("--python-expr"));
  assert.ok(exec?.kind === "exec" && exec.args.at(-1)?.includes('m = "auto_rig_pro-master"'));
});

test("blender: a zip with backslash entry names (PowerShell 5.1 Compress-Archive) is read correctly", async () => {
  const root = await makeTmp();
  const { strToU8, zipSync } = await import("fflate");
  await writeFile(join(root, "addon.zip"), zipSync({ "my_addon\\__init__.py": strToU8("bl_info = {}\n") }));
  const env = blenderEnv(root, ["4.2"]);
  const plan = await planInstall(ctx(root, env, [{ type: "blender", source: "addon.zip" }]));
  assert.deepEqual(plan.items.map((i) => i.kind === "blender-addon" && i.module), ["my_addon"]);
});

test("blender: a developer link where the add-on goes is refused, or removed as a link first", async () => {
  const root = await makeTmp();
  await writeFile(join(root, "addon.zip"), legacyAddonZip("my_addon"));
  const env = blenderEnv(root, ["4.2"]);
  const addons = join(env.paths.appData, "Blender Foundation", "Blender", "4.2", "scripts", "addons");
  const working = join(root, "my_addon-src");
  await mkdir(working, { recursive: true });
  await mkdir(addons, { recursive: true });
  await symlink(working, join(addons, "my_addon"), "junction");

  const components: Component[] = [{ type: "blender", source: "addon.zip" }];
  await assert.rejects(planInstall(ctx(root, env, components)), /developer link/);

  const plan = await planInstall(ctx(root, env, components, { replaceDevLinks: true }));
  const kinds = plan.actions.map((a) => a.kind);
  assert.deepEqual(kinds, ["ensureNotRunning", "removePath", "exec"]);
  assert.ok(plan.actions[1]?.kind === "removePath" && plan.actions[1].path === join(addons, "my_addon"));
});

test("blender: uninstall leaves a developer-linked extension alone", async () => {
  const root = await makeTmp();
  const env = blenderEnv(root, ["4.2"]);
  const ext = join(env.paths.appData, "Blender Foundation", "Blender", "4.2", "extensions", "user_default");
  await mkdir(join(root, "ext-src"), { recursive: true });
  await mkdir(ext, { recursive: true });
  await symlink(join(root, "ext-src"), join(ext, "my_ext"), "junction");

  const { planUninstall } = await import("../src/index.ts");
  const plan = await planUninstall(
    {
      id: "pkg",
      name: "Pkg",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      apps: ["blender"],
      items: [{ kind: "blender-extension", exe: join(root, "Blender 4.2", "blender.exe"), version: "4.2", id: "my_ext" }],
    },
    env,
  );
  assert.ok(!plan.actions.some((a) => a.kind === "exec"));
  assert.match(plan.warnings.join("\n"), /left developer link in place/);
});

test("blender: no compatible version is an error that names what is installed", async () => {
  const root = await makeTmp();
  await writeFile(join(root, "ext.zip"), blenderExtensionZip("my_ext"));
  const env = blenderEnv(root, ["3.6", "4.1"]);
  await assert.rejects(planInstall(ctx(root, env, [{ type: "blender", source: "ext.zip" }])), /installed: 3\.6, 4\.1/);
});

test("upgrade removes what the previous version installed and the new one does not", async () => {
  const { pkgRoot, env } = await cepFixture();
  const previous: Receipt = {
    id: "pkg",
    name: "Pkg",
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    apps: ["aftereffects"],
    items: [
      { kind: "path", path: join(env.cep.user, "com.test.panel") },
      { kind: "path", path: join(env.cep.user, "old.panel") },
    ],
  };
  const plan = await planInstall(ctx(pkgRoot, env, [cep]), previous);
  const removals = plan.actions.filter((a) => a.kind === "removePath");
  assert.deepEqual(
    removals.map((a) => a.kind === "removePath" && a.path),
    [join(env.cep.user, "old.panel")],
  );
});
