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

test("a download link only works with its job's token", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/download/nope?t=x`);
  assert.equal(res.status, 404);
});
