// A real server and a real agent talking over WebSocket on loopback. The
// agent installs into a fake folder tree, never into the real CEP folders.

import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startAgent, type AgentStatus, type RunningAgent } from "../../agent/src/agent.ts";
import { fakeEnv, makeTmp, noProcesses, write, writeCepPanel } from "../../core/test/helpers.ts";
import { startServer, type RunningServer } from "../src/server.ts";

let root: string;
let server: RunningServer;
const agents: RunningAgent[] = [];

async function api(method: string, path: string, body?: unknown, token = server.adminToken) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "x-zeploy-admin": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function writePackage(dir: string, version: string, marker: string) {
  await write(
    join(dir, "zeploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "colosave",
      name: "Colosave",
      version,
      components: [{ type: "cep", source: "panel" }],
    }),
  );
  await writeCepPanel(join(dir, "panel"), "com.colosave.panel");
  await write(join(dir, "panel", "marker.txt"), marker);
}

function launchAgent(token: string, onStatus?: (s: AgentStatus) => void): RunningAgent {
  const env = fakeEnv(join(root, "pc"));
  const agent = startAgent({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token,
    agentId: "agent-test-0001",
    info: { hostname: "TEST-PC", user: "tester" },
    detect: async () => env,
    exec: { processes: noProcesses },
    log: () => {},
    onStatus,
  });
  agents.push(agent);
  return agent;
}

async function agentOnline(online: boolean) {
  return waitFor(`agent ${online ? "online" : "offline"}`, async () => {
    const { body } = await api("GET", "/api/state");
    const a = body.agents.find((x: any) => x.id === "agent-test-0001");
    return (online ? a?.online : a && !a.online) ? a : null;
  });
}

async function jobFinished(id: string) {
  return waitFor(`job ${id}`, async () => {
    const { body } = await api("GET", `/api/job?id=${id}`);
    return body.status === "done" || body.status === "failed" ? body : null;
  });
}

before(async () => {
  root = await makeTmp();
  await write(join(root, "build", "zeploy-agent.exe"), "fake agent");
  await write(join(root, "build", "zeploy-agent.json"), JSON.stringify({ version: "9.0.0" }));
  server = await startServer({
    dataDir: join(root, "admin"),
    port: 0,
    host: "127.0.0.1",
    agentExe: join(root, "build", "zeploy-agent.exe"),
    log: () => {},
  });
});

after(async () => {
  for (const a of agents) await a.stop();
  await server.close();
});

test("admin API needs the admin token and a localhost Host header", async () => {
  assert.equal((await api("GET", "/api/state", undefined, "wrong")).status, 401);

  const status = await new Promise<number>((resolveStatus) => {
    request(
      { host: "127.0.0.1", port: server.port, path: "/api/state", headers: { host: "evil.example:80", "x-zeploy-admin": server.adminToken } },
      (res) => resolveStatus(res.statusCode ?? 0),
    ).end();
  });
  assert.equal(status, 403);
});

test("an agent with the wrong team token is rejected", async () => {
  const seen: AgentStatus[] = [];
  const agent = launchAgent("not-the-token", (s) => seen.push(s));
  await waitFor("rejection", async () => seen.includes("rejected"));
  await agent.stop();
  assert.deepEqual((await api("GET", "/api/state")).body.agents, []);
});

test("import, push install, report state, uninstall", async () => {
  await writePackage(join(root, "pkg-v1"), "1.0.0", "v1");
  const preview = await api("POST", "/api/packages/inspect", { path: join(root, "pkg-v1") });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(
    { name: preview.body.name, version: preview.body.version, apps: preview.body.apps, status: preview.body.status },
    { name: "Colosave", version: "1.0.0", apps: ["aftereffects"], status: "new" },
  );
  assert.deepEqual((await api("GET", "/api/state")).body.packages, [], "inspect stores nothing");

  const imported = await api("POST", "/api/packages/import", { path: join(root, "pkg-v1") });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.version, "1.0.0");
  assert.deepEqual(imported.body.apps, ["aftereffects"]);
  assert.equal((await api("POST", "/api/packages/inspect", { path: join(root, "pkg-v1") })).body.status, "same");

  // Same version, different content: refused.
  await writePackage(join(root, "pkg-v1b"), "1.0.0", "changed");
  assert.equal((await api("POST", "/api/packages/inspect", { path: join(root, "pkg-v1b") })).body.status, "conflict");
  assert.equal((await api("POST", "/api/packages/import", { path: join(root, "pkg-v1b") })).status, 409);
  assert.match(
    (await api("POST", "/api/packages/inspect", { path: join(root, "nope") })).body.error,
    /not found/,
  );

  const agent = launchAgent(server.store.data.enrollToken);
  const record = await agentOnline(true);
  assert.equal(record.hostname, "TEST-PC");

  const jobs = await api("POST", "/api/jobs", { action: "install", packageId: "colosave", agentIds: ["agent-test-0001"] });
  assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
  const done = await jobFinished(jobs.body[0].id);
  assert.equal(done.status, "done", done.error);
  assert.ok(done.log.some((l: string) => l.includes("copy folder")));

  const cepUser = fakeEnv(join(root, "pc")).cep.user;
  assert.ok(await stat(join(cepUser, "com.colosave.panel", "marker.txt")));
  await waitFor("receipt in agent state", async () => {
    const { body } = await api("GET", "/api/state");
    return body.agents[0]?.state?.receipts?.some((r: any) => r.id === "colosave" && r.version === "1.0.0");
  });

  const un = await api("POST", "/api/jobs", { action: "uninstall", packageId: "colosave", agentIds: ["agent-test-0001"] });
  assert.equal((await jobFinished(un.body[0].id)).status, "done");
  await assert.rejects(stat(join(cepUser, "com.colosave.panel")));
  await agent.stop();
});

test("a job for an offline PC waits and runs when it connects", async () => {
  await agentOnline(false);
  await writePackage(join(root, "pkg-v2"), "1.1.0", "v2");
  await api("POST", "/api/packages/import", { path: join(root, "pkg-v2") });

  const jobs = await api("POST", "/api/jobs", { action: "install", packageId: "colosave", agentIds: ["agent-test-0001"] });
  const queued = await api("GET", `/api/job?id=${jobs.body[0].id}`);
  assert.equal(queued.body.status, "queued");
  assert.equal(queued.body.version, "1.1.0");

  launchAgent(server.store.data.enrollToken);
  const done = await jobFinished(jobs.body[0].id);
  assert.equal(done.status, "done", done.error);
});

test("a PC keeps the name the admin gave it across reconnects", async () => {
  await agentOnline(true);
  const renamed = await api("POST", "/api/agents/rename", { id: "agent-test-0001", label: "  Rizky's PC  " });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.label, "Rizky's PC");

  for (const a of agents.splice(0)) await a.stop();
  await agentOnline(false);
  launchAgent(server.store.data.enrollToken);
  const back = await agentOnline(true);
  assert.equal(back.label, "Rizky's PC");
  assert.equal(back.hostname, "TEST-PC");

  assert.equal((await api("POST", "/api/agents/rename", { id: "agent-test-0001", label: "x".repeat(61) })).status, 400);
  assert.equal((await api("POST", "/api/agents/rename", { id: "nope", label: "x" })).status, 404);

  // An empty name goes back to the Windows computer name.
  const cleared = await api("POST", "/api/agents/rename", { id: "agent-test-0001", label: "" });
  assert.equal(cleared.body.label, undefined);
});

test("the admin API saves a one-click installer with this server's team token", async () => {
  assert.equal((await api("GET", "/api/state")).body.installerReady, true);
  const folder = join(root, "share");
  await write(join(folder, ".keep"));

  const saved = await api("POST", "/api/installer", { folder, server: "192.168.1.72:7420" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const cmd = await readFile(saved.body.cmd, "utf8");
  assert.ok(cmd.includes(`set "ZD_TOKEN=${server.store.data.enrollToken}"`));
  assert.equal(await readFile(saved.body.exe, "utf8"), "fake agent");

  const bad = await api("POST", "/api/installer", { folder, server: "192.168.1.72 & calc" });
  assert.equal(bad.status, 400);
});

// An agent with a fake updater: instead of swapping exes, replace() starts a
// second agent with the same PC id that reports the new version.
function launchUpdatableAgent(id: string, replace: (file: string, version: string) => Promise<void>) {
  let replaced = false;
  const agent = startAgent({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: server.store.data.enrollToken,
    agentId: id,
    info: { hostname: "UPDATE-PC", user: "tester", agentVersion: "8.0.0" },
    detect: async () => fakeEnv(join(root, id)),
    exec: { processes: noProcesses },
    log: () => {},
    updater: { replace: (file, version) => replace(file, version) },
    onReplaced: () => (replaced = true),
  });
  agents.push(agent);
  return { agent, wasReplaced: () => replaced };
}

async function agentRecord(id: string, check: (a: any) => boolean) {
  return waitFor(`agent ${id}`, async () => {
    const { body } = await api("GET", "/api/state");
    const a = body.agents.find((x: any) => x.id === id);
    return a && check(a) ? a : null;
  });
}

test("an agent updates itself to the exe the admin app has", async () => {
  const { body: state } = await waitFor("agent build", async () => {
    const r = await api("GET", "/api/state");
    return r.body.agentBuild ? r : null;
  });
  assert.deepEqual(state.agentBuild, { version: "9.0.0" });

  // agent-test-0001 has no updater, as when run from source.
  const refused = await api("POST", "/api/agents/update", { agentIds: ["agent-test-0001"] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /cannot update itself/);

  const id = "agent-update-0001";
  let downloaded = "";
  const old = launchUpdatableAgent(id, async (file, version) => {
    downloaded = await readFile(file, "utf8");
    const next = startAgent({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: server.store.data.enrollToken,
      agentId: id,
      info: { hostname: "UPDATE-PC", user: "tester", agentVersion: version },
      detect: async () => fakeEnv(join(root, id)),
      log: () => {},
    });
    agents.push(next);
    await waitFor("new agent connected", async () => next.connected);
  });
  await agentRecord(id, (a) => a.online && a.features?.includes("self-update"));

  const jobs = await api("POST", "/api/agents/update", { agentIds: [id] });
  assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
  assert.equal(jobs.body[0].action, "updateAgent");
  assert.equal(jobs.body[0].version, "9.0.0");

  const done = await jobFinished(jobs.body[0].id);
  assert.equal(done.status, "done", done.error);
  assert.ok(done.log.some((l: string) => l.includes("agent 9.0.0 connected")));
  assert.equal(downloaded, "fake agent", "the agent downloaded the admin's exe");
  await waitFor("the old agent told to exit", async () => old.wasReplaced());
  await agentRecord(id, (a) => a.online && a.agentVersion === "9.0.0");

  const again = await api("POST", "/api/agents/update", { agentIds: [id] });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already runs agent 9\.0\.0/);
});

test("a failed agent update keeps the old agent connected", async () => {
  const id = "agent-update-0002";
  launchUpdatableAgent(id, async () => {
    throw new Error("the downloaded agent did not report version 9.0.0 (exit code 1)");
  });
  await agentRecord(id, (a) => a.online);

  const jobs = await api("POST", "/api/agents/update", { agentIds: [id] });
  const failed = await jobFinished(jobs.body[0].id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /did not report version/);
  const record = await agentRecord(id, (a) => a.online);
  assert.equal(record.agentVersion, "8.0.0");
});

test("a plugin without zeploy.json: details are read, typed over, and a new version joins its package", async () => {
  // A dropped script: uploaded, then added from where the server put it.
  const res = await fetch(`http://127.0.0.1:${server.port}/api/packages/upload?name=Layer%20Tools.jsx`, {
    method: "POST",
    headers: { "x-zeploy-admin": server.adminToken },
    body: "(function (thisObj) { thisObj instanceof Panel; })(this);",
  });
  const { path } = (await res.json()) as { path: string };
  assert.ok(path.endsWith("Layer Tools.jsx"));

  const incomplete = await api("POST", "/api/packages/inspect", { path });
  assert.equal(incomplete.status, 200, JSON.stringify(incomplete.body));
  assert.equal(incomplete.body.status, "incomplete");
  assert.deepEqual(incomplete.body.detected.missing, ["version"]);
  assert.equal(incomplete.body.id, "layer-tools");
  assert.equal((await api("POST", "/api/packages/import", { path })).status, 400);
  assert.match((await api("POST", "/api/packages/inspect", { path, overrides: { version: "1.2" } })).body.error, /version: must look like 1\.2\.3/);

  const overrides = { version: "1.0.0", name: "Layer Tools" };
  const ready = await api("POST", "/api/packages/inspect", { path, overrides });
  assert.equal(ready.body.status, "new");
  assert.deepEqual(ready.body.apps, ["aftereffects"]);
  const added = await api("POST", "/api/packages/import", { path, overrides });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.name, "Layer Tools");
  assert.deepEqual(added.body.keys, ["ae-script:layer tools.jsx"]);
  await assert.rejects(stat(path), "the upload is gone once added");

  // The colosave panel as a bare folder, no zeploy.json: it was added with
  // one as "colosave", and the same panel joins that package.
  const panel = join(root, "bare-colosave", "com.colosave.panel");
  await writeCepPanel(panel, "com.colosave.panel");
  const same = await api("POST", "/api/packages/inspect", { path: panel });
  assert.equal(same.body.id, "colosave");
  assert.equal(same.body.name, "Colosave");
  assert.equal(same.body.detected.from, "CSXS/manifest.xml");
  assert.deepEqual(same.body.detected.updates, { id: "colosave", name: "Colosave", version: "1.1.0" });
  // Its manifest still says 1.0.0, which is in the repository with other files.
  assert.equal(same.body.status, "conflict");
  assert.match((await api("POST", "/api/packages/import", { path: panel })).body.error, /raise the version/);

  const next = await api("POST", "/api/packages/import", { path: panel, overrides: { version: "1.2.0" } });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual([next.body.id, next.body.version], ["colosave", "1.2.0"]);
  const again = await api("POST", "/api/packages/inspect", { path: panel, overrides: { version: "1.2.0" } });
  assert.equal(again.body.status, "same", "adding the same plugin twice is no conflict");
});

test("a download link only works with its job's token", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/download/nope?t=x`);
  assert.equal(res.status, 404);
});
