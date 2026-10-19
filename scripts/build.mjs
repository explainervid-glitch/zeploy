// Builds the deliverables into <build>, by default %LOCALAPPDATA%\zeploy-build:
//   node scripts/build.mjs admin [--launch]
//       <build>\admin (the app files) and a runnable copy with the Electron
//       runtime at %LOCALAPPDATA%\Programs\zeploy-admin\zeploy-admin.exe
//   node scripts/build.mjs agent
//       <build>\zeploy-agent\zeploy-agent.exe (Node single executable)
//
// The sources are TypeScript run directly by Node during development; esbuild
// bundles them into one CommonJS file for Electron and for the Node SEA blob.
//
// Build output stays on a local disk. On the network share the NAS keeps
// just-deleted folders locked for minutes (EPERM / EEXIST on the next build),
// and Electron cannot start from a mapped drive such as Z: at all.

import { execFileSync, spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AGENT_VERSION as version } from "../packages/agent/src/version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const r = (...p) => join(root, ...p);
const buildDir = process.env.ZEPLOY_BUILD_DIR ?? join(process.env.LOCALAPPDATA ?? join(root, "dist"), "zeploy-build");
const adminInstallDir =
  process.env.ZEPLOY_ADMIN_OUT ?? join(process.env.LOCALAPPDATA ?? root, "Programs", "zeploy-admin");

async function readText(path) {
  return readFile(path, "utf8").catch(() => null);
}

// Copies the Electron runtime (only when its version changed) and the app
// files into adminInstallDir, with electron.exe renamed to zeploy-admin.exe.
async function assembleAdmin(appDir) {
  const electronDist = r("node_modules", "electron", "dist");
  const electronVersion = await readText(join(electronDist, "version"));
  if (!electronVersion) throw new Error("Electron runtime missing; run: npm run setup:electron");
  if ((await readText(join(adminInstallDir, "version"))) !== electronVersion) {
    console.log(`copying Electron ${electronVersion.trim()} to ${adminInstallDir}`);
    await rm(adminInstallDir, { recursive: true, force: true });
    await cp(electronDist, adminInstallDir, {
      recursive: true,
      filter: (src) => basename(src).toLowerCase() !== "electron.exe" || src === electronDist,
    });
    await copyFile(join(electronDist, "electron.exe"), join(adminInstallDir, "zeploy-admin.exe"));
  }
  const resourcesApp = join(adminInstallDir, "resources", "app");
  await rm(resourcesApp, { recursive: true, force: true });
  await cp(appDir, resourcesApp, { recursive: true });
  const exe = join(adminInstallDir, "zeploy-admin.exe");
  console.log(`admin app ready: ${exe}`);

  // The copy assembled before the app was renamed from "zdeploy".
  if (!process.env.ZEPLOY_ADMIN_OUT) {
    const legacy = join(process.env.LOCALAPPDATA ?? root, "Programs", "zdeploy-admin");
    await rm(legacy, { recursive: true, force: true }).then(
      () => {},
      () => console.warn(`could not remove ${legacy}; close the old zdeploy admin app and delete it`),
    );
  }
  return exe;
}

async function buildAdmin() {
  const out = join(buildDir, "admin");
  await rm(out, { recursive: true, force: true });
  await build({
    entryPoints: [r("packages", "admin", "src", "main.ts")],
    outfile: join(out, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // ws loads these native speed-ups only if present.
    external: ["electron", "bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
  await cp(r("packages", "server", "ui"), join(out, "ui"), { recursive: true });
  await copyFile(r("packages", "admin", "preload.cjs"), join(out, "preload.cjs"));
  // The admin app hands this exe out with the one-click installer and to
  // agents that update themselves; zeploy-agent.json holds its version.
  const agentExe = join(buildDir, "zeploy-agent", "zeploy-agent.exe");
  if (await stat(agentExe).then(() => true, () => false)) {
    await mkdir(join(out, "agent"), { recursive: true });
    await copyFile(agentExe, join(out, "agent", "zeploy-agent.exe"));
    const sidecar = join(buildDir, "zeploy-agent", "zeploy-agent.json");
    if (await stat(sidecar).then(() => true, () => false)) {
      await copyFile(sidecar, join(out, "agent", "zeploy-agent.json"));
    } else {
      console.warn(`${sidecar} not found: run npm run build:agent again, or PCs are not offered agent updates`);
    }
  } else {
    console.warn(`${agentExe} not found: run npm run build:agent first, or the admin app cannot save installers`);
  }
  await writeFile(
    join(out, "package.json"),
    JSON.stringify({ name: "zeploy-admin", productName: "zeploy", version, main: "main.cjs" }, null, 2),
  );
  console.log(`built ${out}`);
  const exe = await assembleAdmin(out);
  if (process.argv.includes("--launch")) {
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  }
}

async function buildAgent() {
  const out = join(buildDir, "zeploy-agent");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const bundle = join(out, "agent.cjs");
  await build({
    entryPoints: [r("packages", "agent", "src", "main.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
  });

  // Node single executable application: node.exe with the bundle injected.
  const blob = join(out, "sea-prep.blob");
  const seaConfig = join(out, "sea-config.json");
  await writeFile(
    seaConfig,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
  const exe = join(out, "zeploy-agent.exe");
  await copyFile(process.execPath, exe);
  execFileSync(
    process.execPath,
    [
      r("node_modules", "postject", "dist", "cli.js"),
      exe,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { stdio: "inherit" },
  );
  await rm(blob);
  await rm(seaConfig);
  // The admin server reads the version of the exe it hands out from here.
  // Asking the exe itself also proves it starts.
  const built = execFileSync(exe, ["version"], { encoding: "utf8" }).trim();
  await writeFile(join(out, "zeploy-agent.json"), JSON.stringify({ version: built }, null, 2) + "\n");
  console.log(`built ${exe} (${built})`);
}

// The agent first: the admin app bundles it.
const target = process.argv[2] ?? "all";
if (target === "agent" || target === "all") await buildAgent();
if (target === "admin" || target === "all") await buildAdmin();
