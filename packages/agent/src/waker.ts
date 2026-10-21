// The waker: zeploy-agent.exe run as SYSTEM from boot (`zeploy-agent waker`).
// The agent itself runs as the signed-in user, so while it is not running
// (signed out, crashed, stopped) nothing else on the PC answers the admin.
// The waker does: it tells the admin the PC is on and whether the agent
// runs, starts the agent's Scheduled Task on request, and sends the end of
// agent.log. Every request is signed with the team token; see the
// protocol's "waker" section.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";
import { run } from "../../core/src/index.ts";
import * as P from "../../protocol/src/index.ts";
import { loadConfig } from "./config.ts";
import { startTask } from "./task.ts";
import { isAlive } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";

// Files in the agent's folder (%LOCALAPPDATA%\zeploy of its user).
export const PID_FILE = "agent.pid";
export const LOG_FILE = "agent.log";
// Written when the agent stops with an error; removed once it connects again.
export const CRASH_FILE = "crash.json";

export interface WakerOptions {
  // The agent's folder.
  home: string;
  // DOMAIN\name the agent runs as.
  user: string;
  port?: number;
  host?: string;
  log?: (line: string) => void;
  // Test seams.
  config?: () => Promise<{ token?: string; agentId?: string }>;
  startAgent?: () => Promise<void>;
  signedIn?: () => Promise<boolean>;
  startWaitMs?: number;
}

export interface RunningWaker {
  readonly port: number;
  close(): Promise<void>;
}

const NONCE_MS = 60_000;
const MAX_NONCES = 64;
const LOG_TAIL_BYTES = 128 * 1024;
const SIGNED_IN_CACHE_MS = 10_000;
const START_WAIT_MS = 20_000;

class WakerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// An explorer.exe of that user means they are signed in (a locked screen too).
async function userSignedIn(user: string): Promise<boolean> {
  const r = await run("tasklist", ["/fi", `USERNAME eq ${user}`, "/fi", "IMAGENAME eq explorer.exe", "/nh", "/fo", "csv"]);
  return /explorer\.exe/i.test(r.stdout);
}

export async function startWaker(options: WakerOptions): Promise<RunningWaker> {
  const log = options.log ?? ((line: string) => console.log(line));
  const config = options.config ?? loadConfig;
  const startAgent = options.startAgent ?? startTask;
  const nonces = new Map<string, number>();

  let signedInCache: { at: number; value: boolean } | null = null;
  async function signedIn(): Promise<boolean> {
    if (options.signedIn) return options.signedIn();
    if (signedInCache && Date.now() - signedInCache.at < SIGNED_IN_CACHE_MS) return signedInCache.value;
    const value = await userSignedIn(options.user).catch(() => false);
    signedInCache = { at: Date.now(), value };
    return value;
  }

  async function agentRunning(): Promise<boolean> {
    try {
      const pid = Number(await readFile(join(options.home, PID_FILE), "utf8"));
      return !!pid && isAlive(pid);
    } catch {
      return false;
    }
  }

  async function crash(): Promise<P.WakerStatus["crash"]> {
    try {
      const c = JSON.parse(await readFile(join(options.home, CRASH_FILE), "utf8")) as { at?: unknown; error?: unknown };
      return { at: String(c.at ?? "").slice(0, 40), error: String(c.error ?? "").slice(0, 2000) };
    } catch {
      return undefined;
    }
  }

  async function status(agentId: string): Promise<P.WakerStatus> {
    const running = await agentRunning();
    const c = running ? undefined : await crash();
    return { agentId, version: AGENT_VERSION, agentRunning: running, signedIn: await signedIn(), ...(c ? { crash: c } : {}) };
  }

  async function wake(): Promise<P.WakerWake> {
    if (await agentRunning()) return { started: true, message: "the agent is already running" };
    signedInCache = null;
    if (!(await signedIn())) {
      return { started: false, message: `nobody is signed in as ${options.user}; the agent starts when they sign in` };
    }
    try {
      await startAgent();
    } catch (err) {
      return { started: false, message: `could not start the agent's Scheduled Task: ${(err as Error).message}`.slice(0, 500) };
    }
    const end = Date.now() + (options.startWaitMs ?? START_WAIT_MS);
    while (Date.now() < end) {
      if (await agentRunning()) {
        log("started the agent");
        return { started: true, message: "the agent started" };
      }
      await sleep(250);
    }
    return { started: false, message: "the agent did not start; its log may say why" };
  }

  // The last LOG_TAIL_BYTES of agent.log, from a line start.
  async function logTail(): Promise<P.WakerLog> {
    const file = join(options.home, LOG_FILE);
    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return { text: "", file };
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      let text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return { text, file };
    } finally {
      await handle.close();
    }
  }

  function newNonce(): string {
    const now = Date.now();
    for (const [n, at] of nonces) if (now - at > NONCE_MS) nonces.delete(n);
    if (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value!);
    const nonce = P.randomToken();
    nonces.set(nonce, now);
    return nonce;
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 4096) throw new WakerError(413, "request too large");
    }
    return text;
  }

  async function act(action: P.WakerAction, req: IncomingMessage): Promise<{ body: string; mac: string }> {
    let request: z.infer<typeof P.wakerRequestSchema>;
    try {
      request = P.wakerRequestSchema.parse(JSON.parse(await readBody(req)));
    } catch (err) {
      if (err instanceof WakerError) throw err;
      throw new WakerError(400, "bad request");
    }
    const issued = nonces.get(request.nonce);
    nonces.delete(request.nonce);
    if (!issued || Date.now() - issued > NONCE_MS) throw new WakerError(401, "unknown or expired nonce");
    const { token, agentId } = await config();
    if (!token || !agentId) throw new WakerError(503, "the agent on this PC is not set up");
    if (request.agentId !== agentId) throw new WakerError(404, "this is another PC");
    if (!P.safeEqual(request.mac, P.wakerRequestMac(token, action, agentId, request.nonce))) {
      throw new WakerError(401, "wrong team token");
    }
    const reply = action === "status" ? await status(agentId) : action === "wake" ? await wake() : await logTail();
    const body = JSON.stringify(reply);
    return { body, mac: P.wakerReplyMac(token, action, request.nonce, body) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === P.WAKER_PATH) return reply(res, 200, { waker: true, version: AGENT_VERSION });
    if (req.method === "GET" && path === `${P.WAKER_PATH}/challenge`) return reply(res, 200, { nonce: newNonce() });
    const action = P.wakerActionSchema.safeParse(path.slice(P.WAKER_PATH.length + 1));
    if (req.method === "POST" && path.startsWith(`${P.WAKER_PATH}/`) && action.success) {
      return reply(res, 200, await act(action.data, req));
    }
    throw new WakerError(404, "not found");
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof WakerError ? err.status : 500;
      if (status === 500) log(`error on ${req.method} ${req.url}: ${(err as Error).stack ?? err}`);
      if (status === 401) log(`refused ${req.url} from ${req.socket.remoteAddress}: ${(err as Error).message}`);
      if (!res.headersSent) reply(res, status, { error: (err as Error).message });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? P.WAKER_PORT, options.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : (options.port ?? P.WAKER_PORT);
  log(`zeploy waker ${AGENT_VERSION} listening on port ${port} for the agent of ${options.user}`);
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// The version of the waker answering on this PC, or null.
export async function localWakerVersion(port = P.WAKER_PORT): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${P.WAKER_PATH}`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { waker?: boolean; version?: string };
    return body.waker ? (body.version ?? null) : null;
  } catch {
    return null;
  }
}
