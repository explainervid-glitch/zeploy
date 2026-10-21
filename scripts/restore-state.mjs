// Rescues the admin's live state when state.json on disk is out of date (an
// admin built before 21 October 2026 stopped saving after one failed write) and puts
// it back before the admin starts again.
//
//   1. With the admin app still running:
//        node scripts/restore-state.mjs save
//      reads the running admin's state and writes it to
//      <data>\rescue\state-<time>.json. Nothing else is changed.
//   2. Close the admin app (and update it).
//   3. node scripts/restore-state.mjs install <data>\rescue\state-<time>.json
//      keeps the old state.json as rescue\state-before-restore-<time>.json
//      and puts the rescued one in its place. Refuses while an admin runs.
//   4. Start the admin app.
//
// Options: --port 7420 (the admin's port), --data <folder> (default
// %APPDATA%\zeploy-admin). The admin's job history keeps its last 100 jobs,
// without their logs; everything else is kept whole.

import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "7420" }, data: { type: "string" } },
});
const [command, source] = positionals;
const port = Number(values.port);
const dataDir = resolve(values.data ?? join(process.env.APPDATA ?? ".", "zeploy-admin"));
const base = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const exists = (path) => stat(path).then(() => true, () => false);

async function adminRunning() {
  return fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}

function summary(state) {
  const agents = Object.values(state.agents);
  return [
    `  PCs       ${agents.length} (${agents.filter((a) => a.role).length} with a role, ${agents.filter((a) => a.label).length} renamed)`,
    `  packages  ${state.packages.length}`,
    `  jobs      ${state.jobs.length}`,
    `  admins    ${(state.admins ?? []).length} other admin computer(s)`,
  ].join("\n");
}

async function save() {
  if (!(await adminRunning())) throw new Error(`no admin answers on ${base}; start it, or pass --port`);
  // The admin token is in the page the admin serves to this computer.
  const page = await fetch(`${base}/`, { headers: { host: `127.0.0.1:${port}` } }).then((r) => r.text());
  const token = /name="admin-token" content="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error("could not read the admin token from the admin page");
  const res = await fetch(`${base}/api/state`, { headers: { "x-zeploy-admin": token } });
  if (!res.ok) throw new Error(`the admin answered HTTP ${res.status}`);
  const live = await res.json();

  const onDisk = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8").catch(() => "{}"));
  const state = {
    version: 1,
    enrollToken: live.enrollToken,
    ...(live.admins?.length ? { admins: live.admins } : {}),
    ...(onDisk.removedAdmins?.length ? { removedAdmins: onDisk.removedAdmins } : {}),
    ...(live.usageEnabled === false ? { usage: false } : {}),
    packages: live.packages,
    agents: Object.fromEntries(live.agents.map(({ online, busy, ...agent }) => [agent.id, agent])),
    // The admin lists jobs newest first, without their logs.
    jobs: [...live.jobs].reverse().map(({ logCount, ...job }) => ({ ...job, log: [] })),
  };
  if (!state.enrollToken || !Array.isArray(state.packages)) throw new Error("the admin's answer does not look like its state");

  const missing = [];
  for (const p of state.packages) if (!(await exists(join(dataDir, "packages", p.file)))) missing.push(p.file);

  await mkdir(join(dataDir, "rescue"), { recursive: true });
  const out = join(dataDir, "rescue", `state-${stamp}.json`);
  await writeFile(out, JSON.stringify(state, null, 2));
  console.log(`Saved the running admin's state to\n  ${out}\n${summary(state)}`);
  if (missing.length) console.log(`warning: ${missing.length} package file(s) missing from ${join(dataDir, "packages")}: ${missing.join(", ")}`);
  console.log(`\nNext: close the admin app, then run\n  node scripts/restore-state.mjs install "${out}"`);
}

async function install(file) {
  if (!file) throw new Error("install needs the rescued file: node scripts/restore-state.mjs install <file>");
  if (await adminRunning()) throw new Error(`an admin is still running on ${base}; close it first, or it may save over the restored file`);
  const state = JSON.parse(await readFile(file, "utf8"));
  if (state.version !== 1 || !state.enrollToken || typeof state.agents !== "object" || !Array.isArray(state.packages) || !Array.isArray(state.jobs)) {
    throw new Error(`${file} is not a zeploy admin state`);
  }
  const target = join(dataDir, "state.json");
  await mkdir(join(dataDir, "rescue"), { recursive: true });
  if (await exists(target)) {
    const kept = join(dataDir, "rescue", `state-before-restore-${stamp}.json`);
    await copyFile(target, kept);
    console.log(`Kept the old state.json as\n  ${kept}`);
  }
  await writeFile(`${target}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${target}.tmp`, target);
  console.log(`Restored ${target}\n${summary(state)}\n\nStart the admin app and check the PCs, names, roles and packages.`);
}

const commands = { save, install: () => install(source) };
if (!commands[command]) {
  console.log("usage: node scripts/restore-state.mjs save | install <file>  [--port 7420] [--data <folder>]");
  process.exitCode = 2;
} else {
  commands[command]().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
