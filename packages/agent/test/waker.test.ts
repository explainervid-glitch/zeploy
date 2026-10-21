import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeTmp, write } from "../../core/test/helpers.ts";
import * as P from "../../protocol/src/index.ts";
import { callWaker } from "../../server/src/waker.ts";
import { createProblems } from "../src/problems.ts";
import { startWaker, type RunningWaker } from "../src/waker.ts";

const TOKEN = "team-token-for-waker-tests";
const AGENT_ID = "agent-waker-0001";
let home: string;
let waker: RunningWaker;
let signedIn = true;
let starts = 0;

const ask = <T>(action: P.WakerAction, schema: import("zod").ZodType<T>, token = TOKEN, agentId = AGENT_ID) =>
  callWaker(["127.0.0.1"], waker.port, token, agentId, action, schema, 5000);

before(async () => {
  home = await makeTmp();
  waker = await startWaker({
    home,
    user: "PC\\artist",
    port: 0,
    host: "127.0.0.1",
    log: () => {},
    config: async () => ({ token: TOKEN, agentId: AGENT_ID }),
    signedIn: async () => signedIn,
    // Starting the agent's task: here, the agent writes its pid file.
    startAgent: async () => {
      starts++;
      await writeFile(join(home, "agent.pid"), String(process.pid));
    },
    startWaitMs: 2000,
  });
});

after(() => waker.close());

test("the waker answers only requests signed with the team token, for its own PC", async () => {
  await assert.rejects(ask("status", P.wakerStatusSchema, "another-token"), /wrong team token/);
  await assert.rejects(ask("status", P.wakerStatusSchema, TOKEN, "agent-other-0002"), /another PC/);

  // A request cannot be sent twice: its nonce is used up.
  const base = `http://127.0.0.1:${waker.port}${P.WAKER_PATH}`;
  const { nonce } = (await (await fetch(`${base}/challenge`)).json()) as { nonce: string };
  const body = JSON.stringify({ agentId: AGENT_ID, nonce, mac: P.wakerRequestMac(TOKEN, "status", AGENT_ID, nonce) });
  const post = () => fetch(`${base}/status`, { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 401);
});

test("status, wake and log while the agent is not running", async () => {
  await write(join(home, "crash.json"), JSON.stringify({ at: "2026-10-21T08:00:00.000Z", error: "not configured" }));
  const down = await ask("status", P.wakerStatusSchema);
  assert.deepEqual(down, {
    agentId: AGENT_ID,
    version: down.version,
    agentRunning: false,
    signedIn: true,
    crash: { at: "2026-10-21T08:00:00.000Z", error: "not configured" },
  });

  signedIn = false;
  const nobody = await ask("wake", P.wakerWakeSchema);
  assert.equal(nobody.started, false);
  assert.match(nobody.message, /nobody is signed in as PC\\artist/);
  assert.equal(starts, 0);

  signedIn = true;
  assert.deepEqual(await ask("wake", P.wakerWakeSchema), { started: true, message: "the agent started" });
  assert.equal(starts, 1);
  const up = await ask("status", P.wakerStatusSchema);
  assert.equal(up.agentRunning, true);
  assert.equal(up.crash, undefined, "a running agent has no crash to report");
  assert.deepEqual(await ask("wake", P.wakerWakeSchema), { started: true, message: "the agent is already running" });
  assert.equal(starts, 1);

  await write(join(home, "agent.log"), "x".repeat(200 * 1024) + "\nline one\nline two\n");
  const log = await ask("log", P.wakerLogSchema);
  assert.equal(log.file, join(home, "agent.log"));
  assert.ok(log.text.endsWith("line one\nline two\n"));
  assert.ok(log.text.length <= 128 * 1024, "only the end of a long log");
});

test("problems: newest first, the same one again is no change, gone after a day", () => {
  let now = Date.parse("2026-10-21T08:00:00.000Z");
  let changes = 0;
  const problems = createProblems(() => changes++, () => now);
  problems.record("could not detect apps");
  now += 1000;
  problems.record("unexpected error: boom");
  now += 1000;
  problems.record("could not detect apps");
  assert.equal(changes, 2);
  assert.deepEqual(
    problems.recent().map((p) => p.message),
    ["could not detect apps", "unexpected error: boom"],
  );
  now += 24 * 60 * 60 * 1000;
  assert.deepEqual(problems.recent(), []);
});
