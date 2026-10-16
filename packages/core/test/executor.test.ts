import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AppRunningError, executePlan, type Plan } from "../src/index.ts";
import { removeSafe, replaceDir } from "../src/fsutil.ts";
import { collectLog, makeTmp, noProcesses, write } from "./helpers.ts";

test("replaceDir swaps in the new copy and skips excluded and VCS files", async () => {
  const root = await makeTmp();
  const from = join(root, "from");
  const to = join(root, "dest", "panel");
  await write(join(from, "index.html"), "new");
  await write(join(from, ".debug"), "port");
  await write(join(from, ".git", "HEAD"), "ref");
  await write(join(to, "stale.js"), "old");

  await replaceDir(from, to, [".debug"]);
  assert.deepEqual((await readdir(to)).sort(), ["index.html"]);
  assert.equal(await readFile(join(to, "index.html"), "utf8"), "new");
  await assert.rejects(stat(`${to}.zdeploy-new`));
});

test("removeSafe deletes a junction without touching the folder it points at", async () => {
  const root = await makeTmp();
  const working = join(root, "working-copy");
  await write(join(working, "src", "main.js"), "precious");
  const link = join(root, "extensions", "panel");
  await mkdir(join(root, "extensions"), { recursive: true });
  await symlink(working, link, "junction");

  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await removeSafe(link), true);
  await assert.rejects(lstat(link));
  assert.equal(await readFile(join(working, "src", "main.js"), "utf8"), "precious");
});

test("replaceDir over a junction replaces the link, not the linked folder", async () => {
  const root = await makeTmp();
  const working = join(root, "working-copy");
  await write(join(working, "main.js"), "precious");
  const from = join(root, "from");
  await write(join(from, "main.js"), "installed");
  const dest = join(root, "extensions", "panel");
  await mkdir(join(root, "extensions"), { recursive: true });
  await symlink(working, dest, "junction");

  await replaceDir(from, dest);
  assert.equal((await lstat(dest)).isSymbolicLink(), false);
  assert.equal(await readFile(join(dest, "main.js"), "utf8"), "installed");
  assert.equal(await readFile(join(working, "main.js"), "utf8"), "precious");
});

function planWithApp(dest: string): Plan {
  return {
    apps: ["aftereffects"],
    items: [],
    warnings: [],
    actions: [
      { kind: "ensureNotRunning", app: "aftereffects", process: "AfterFX.exe" },
      { kind: "removePath", path: dest, reason: "test" },
    ],
  };
}

test("a running app stops the plan before any change by default", async () => {
  const root = await makeTmp();
  const dest = join(root, "keep");
  await write(join(dest, "f"), "x");
  const { log } = collectLog();
  const processes = async () => new Set(["afterfx.exe"]);

  await assert.rejects(executePlan(planWithApp(dest), { dryRun: false, ifRunning: "fail", log, processes }), AppRunningError);
  assert.ok(await stat(dest));
});

test("--if-running kill closes the app first", async () => {
  const root = await makeTmp();
  const dest = join(root, "gone");
  await write(join(dest, "f"), "x");
  const killed: string[] = [];
  const { log } = collectLog();

  await executePlan(planWithApp(dest), {
    dryRun: false,
    ifRunning: "kill",
    log,
    processes: async () => new Set(["afterfx.exe"]),
    kill: async (name) => {
      killed.push(name);
    },
  });
  assert.deepEqual(killed, ["AfterFX.exe"]);
  await assert.rejects(stat(dest));
});

test("a dry run changes nothing and reports a running app instead of failing", async () => {
  const root = await makeTmp();
  const dest = join(root, "keep");
  await write(join(dest, "f"), "x");
  const { lines, log } = collectLog();

  await executePlan(planWithApp(dest), {
    dryRun: true,
    ifRunning: "fail",
    log,
    processes: async () => new Set(["afterfx.exe"]),
  });
  assert.ok(await stat(dest));
  assert.match(lines.join("\n"), /After Effects is running/);
  assert.match(lines.join("\n"), /would remove/);
});

test("exec failures carry the command output", async () => {
  const { log } = collectLog();
  const plan: Plan = {
    apps: [],
    items: [],
    warnings: [],
    actions: [{ kind: "exec", label: "failing step", file: "cmd", args: ["/c", "echo boom 1>&2 & exit 3"] }],
  };
  await assert.rejects(
    executePlan(plan, { dryRun: false, ifRunning: "fail", log, processes: noProcesses }),
    /failing step failed \(exit 3\):\s+boom/,
  );
});
