// The agent on each team PC: keeps a WebSocket open to the admin server,
// runs the install and uninstall jobs it is sent, and reports what is
// installed. Jobs run one at a time through packages/core.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  detectEnvironment,
  installPackage,
  listReceipts,
  uninstallPackage,
  type Environment,
  type ExecuteOptions,
} from "../../core/src/index.ts";
import * as P from "../../protocol/src/index.ts";

export const AGENT_VERSION = "0.2.0";

export type AgentStatus = "connecting" | "connected" | "disconnected" | "rejected";

export interface AgentOptions {
  // http://192.168.1.10:7420
  serverUrl: string;
  token: string;
  agentId: string;
  log?: (line: string) => void;
  onStatus?: (status: AgentStatus) => void;
  // Test seams.
  detect?: () => Promise<Environment>;
  exec?: Pick<ExecuteOptions, "processes" | "kill">;
  info?: Partial<P.AgentInfo>;
}

export interface RunningAgent {
  readonly connected: boolean;
  stop(): Promise<void>;
  // Resolves when every job received so far has finished.
  idle(): Promise<void>;
}

const SILENCE_LIMIT_MS = 75_000;
const MAX_BACKOFF_MS = 30_000;

export function startAgent(options: AgentOptions): RunningAgent {
  const log = options.log ?? ((line: string) => console.log(line));
  const detect = options.detect ?? (() => detectEnvironment());
  const base = options.serverUrl.replace(/\/+$/, "");
  const wsUrl = base.replace(/^http/i, "ws") + P.AGENT_PATH;
  const info: P.AgentInfo = {
    hostname: hostname(),
    user: userInfo().username,
    agentVersion: AGENT_VERSION,
    ...options.info,
  };

  let stopped = false;
  let socket: WebSocket | null = null;
  let channel: P.SecureChannel | null = null;
  let backoff = 1000;
  let retryTimer: NodeJS.Timeout | null = null;
  let jobs: Promise<void> = Promise.resolve();

  const setStatus = (s: AgentStatus) => options.onStatus?.(s);

  // Sends on whatever connection is current. Messages about a job that
  // outlived its connection are dropped; the server already failed that job.
  function send(message: P.AgentMessage): void {
    if (channel && socket?.readyState === WebSocket.OPEN) socket.send(channel.seal(message));
  }

  async function sendState(): Promise<void> {
    try {
      const env = await detect();
      const receipts = await listReceipts(env);
      send({
        type: "state",
        state: {
          isAdmin: env.isAdmin,
          adobe: env.adobe.map((a) => ({ app: a.app, version: a.version })),
          blender: env.blender.map((b) => b.version),
          receipts: receipts.map((r) => ({ id: r.id, version: r.version, installedAt: r.installedAt })),
        },
      });
    } catch (err) {
      log(`could not report state: ${(err as Error).message}`);
    }
  }

  // Streams the zip to disk, hashing as it goes, and refuses it unless the
  // hash is the one in the (authenticated) job message.
  async function download(job: Extract<P.JobSpec, { action: "install" }>, env: Environment): Promise<string> {
    const dir = join(env.home, "downloads");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${job.packageId}-${job.version}-${job.id.slice(0, 8)}.zip`);
    const res = await fetch(base + job.downloadPath);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(file),
    );
    const actual = hash.digest("hex");
    if (actual !== job.sha256) {
      await rm(file, { force: true });
      throw new Error(`downloaded package does not match its SHA-256 (got ${actual})`);
    }
    return file;
  }

  async function runJob(job: P.JobSpec): Promise<void> {
    const jobLog = (line: string) => {
      log(line);
      send({ type: "jobLog", jobId: job.id, line });
    };
    send({ type: "jobStarted", jobId: job.id });
    jobLog(`${job.action} ${job.packageId}${job.action === "install" ? ` ${job.version}` : ""} on ${info.hostname}`);

    let zip: string | null = null;
    try {
      const env = await detect();
      const exec: ExecuteOptions = { dryRun: false, ifRunning: job.options.ifRunning, log: jobLog, ...options.exec };
      if (job.action === "install") {
        zip = await download(job, env);
        await installPackage(zip, env, {
          ...exec,
          expectedSha256: job.sha256,
          plan: { scope: job.options.scope, replaceDevLinks: job.options.replaceDevLinks },
        });
      } else {
        await uninstallPackage(job.packageId, env, exec);
      }
      send({ type: "jobDone", jobId: job.id, ok: true });
    } catch (err) {
      const message = (err as Error).message;
      jobLog(`error: ${message}`);
      send({ type: "jobDone", jobId: job.id, ok: false, error: message });
    } finally {
      if (zip) await rm(zip, { force: true });
    }
    await sendState();
  }

  function handle(message: P.ServerMessage): void {
    switch (message.type) {
      case "ping":
        return;
      case "refresh":
        void sendState();
        return;
      case "job":
        jobs = jobs.then(() => runJob(message.job));
        return;
    }
  }

  function connect(): void {
    if (stopped) return;
    setStatus("connecting");
    const ws = new WebSocket(wsUrl);
    socket = ws;
    const agentNonce = P.randomToken();
    let nonce: string | null = null;
    let lastMessage = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage > SILENCE_LIMIT_MS) ws.close();
    }, 15_000);

    ws.addEventListener("message", (event) => {
      lastMessage = Date.now();
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString();
      try {
        if (nonce === null) {
          const challenge = P.challengeSchema.parse(JSON.parse(text));
          if (challenge.protocol !== P.PROTOCOL_VERSION) {
            throw new P.ProtocolError(`server speaks protocol ${challenge.protocol}, this agent ${P.PROTOCOL_VERSION}`);
          }
          nonce = challenge.nonce;
          const hello: P.Hello = {
            type: "hello",
            protocol: P.PROTOCOL_VERSION,
            agentId: options.agentId,
            agentNonce,
            info,
            mac: P.helloMac(options.token, nonce, options.agentId, agentNonce),
          };
          ws.send(JSON.stringify(hello));
          return;
        }
        if (channel === null) {
          const welcome = P.welcomeSchema.parse(JSON.parse(text));
          if (!P.safeEqual(welcome.mac, P.welcomeMac(options.token, nonce, agentNonce))) {
            throw new P.ProtocolError("the server could not prove it knows the team token");
          }
          channel = new P.SecureChannel(P.sessionKey(options.token, nonce, agentNonce), "agent");
          backoff = 1000;
          log(`connected to ${base}`);
          setStatus("connected");
          void sendState();
          return;
        }
        handle(P.serverMessageSchema.parse(channel.open(text)));
      } catch (err) {
        log(`protocol error: ${(err as Error).message}`);
        ws.close();
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(watchdog);
      if (socket === ws) {
        socket = null;
        channel = null;
      }
      if (event.code === 4001) {
        log("the server rejected the team token; check the agent configuration");
        setStatus("rejected");
        backoff = MAX_BACKOFF_MS;
      } else {
        setStatus("disconnected");
      }
      if (!stopped) {
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    });
    ws.addEventListener("error", () => {
      // A close event always follows; reconnecting happens there.
    });
  }

  connect();

  return {
    get connected() {
      return channel !== null;
    },
    idle: () => jobs,
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      await jobs;
    },
  };
}
