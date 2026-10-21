// The admin server and a PC's waker on loopback: a PC whose agent is
// offline shows as on (idle) or stopped with an error, can be woken, and
// its log read.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startWaker, type RunningWaker } from "../../agent/src/waker.ts";
import { makeTmp, write } from "../../core/test/helpers.ts";
import * as P from "../../protocol/src/index.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const AGENT_ID = "agent-waker-0001";
let root: string;
let server: RunningServer;
let waker: RunningWaker;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "x-zeploy-admin": server.adminToken, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function wakerSeen(want: (status: any) => boolean) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const { body } = await api("GET", "/api/state");
    const seen = body.agents.find((a: any) => a.id === AGENT_ID)?.waker;
    if (seen && want(seen.status)) return seen;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the waker's status");
}

before(async () => {
  root = await makeTmp();
  const home = join(root, "pc");
  // The waker starts first, on a free port the server is told about.
  let token = "";
  waker = await startWaker({
    home,
    user: "PC\\artist",
    port: 0,
    host: "127.0.0.1",
    log: () => {},
    config: async () => ({ token, agentId: AGENT_ID }),
    signedIn: async () => true,
    startAgent: () => writeFile(join(home, "agent.pid"), String(process.pid)),
    startWaitMs: 2000,
  });
  server = await startServer({
    dataDir: join(root, "admin"),
    port: 0,
    host: "127.0.0.1",
    log: () => {},
    wakerPort: waker.port,
    wakerCheckMs: 100,
  });
  token = server.store.data.enrollToken;
  // A PC that connected once with agent 0.9.0 and is offline now.
  server.store.data.agents[AGENT_ID] = {
    id: AGENT_ID,
    hostname: "PC",
    user: "artist",
    agentVersion: "0.9.0",
    features: [P.FEATURE_WAKER],
    address: "127.0.0.1",
    firstSeen: "2026-10-21T08:00:00.000Z",
    lastSeen: "2026-10-21T08:00:00.000Z",
    state: null,
  };
  await write(join(home, "crash.json"), JSON.stringify({ at: "2026-10-21T08:05:00.000Z", error: "not configured" }));
  await write(join(home, "agent.log"), "starting\nerror: not configured\n");
});

after(async () => {
  await server.close();
  await waker.close();
});

test("an offline PC's waker says the agent stopped; Wake up starts it, and the log can be read", async () => {
  const stopped = await wakerSeen((s) => s?.crash);
  assert.equal(stopped.status.agentRunning, false);
  assert.equal(stopped.status.crash.error, "not configured");

  const log = await api("POST", "/api/agents/log", { id: AGENT_ID });
  assert.equal(log.status, 200, JSON.stringify(log.body));
  assert.equal(log.body.text, "starting\nerror: not configured\n");

  const woke = await api("POST", "/api/agents/wake", { id: AGENT_ID });
  assert.equal(woke.status, 200, JSON.stringify(woke.body));
  assert.deepEqual(woke.body, { started: true, message: "the agent started" });
  await wakerSeen((s) => s?.agentRunning === true);
});

test("a PC without a waker, or with one that does not answer, gets a clear error", async () => {
  server.store.data.agents["agent-old-0002"] = {
    id: "agent-old-0002",
    hostname: "OLD",
    user: "artist",
    agentVersion: "0.8.0",
    features: [],
    address: "127.0.0.1",
    firstSeen: "2026-10-21T08:00:00.000Z",
    lastSeen: "2026-10-21T08:00:00.000Z",
    state: null,
  };
  const old = await api("POST", "/api/agents/wake", { id: "agent-old-0002" });
  assert.equal(old.status, 409);
  assert.match(old.body.error, /agent 0\.8\.0, which has no waker/);

  // Another PC id at the same address: the waker there refuses it.
  server.store.data.agents["agent-gone-0003"] = { ...server.store.data.agents["agent-old-0002"]!, id: "agent-gone-0003", hostname: "GONE", features: [P.FEATURE_WAKER] };
  const gone = await api("POST", "/api/agents/log", { id: "agent-gone-0003" });
  assert.equal(gone.status, 502);
  assert.match(gone.body.error, /could not reach the waker on GONE \(this is another PC\)/);
});
