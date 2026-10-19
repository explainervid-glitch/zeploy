// The agent on each team PC: keeps a WebSocket open to the admin server,
// runs the install, uninstall and agent update jobs it is sent, and reports
// what is installed. Jobs run one at a time through packages/core.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  detectEnvironment,
  installPackage,
  listReceipts,
  scanInstalled,
  uninstallPackage,
  type Environment,
  type ExecuteOptions,
} from "../../core/src/index.ts";
import * as P from "../../protocol/src/index.ts";
import type { AgentUpdater } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";

export type AgentStatus = "connecting" | "connected" | "disconnected" | "rejected";

export interface AgentOptions {
  // http://192.168.1.10:7420
  serverUrl: string;
  token: string;
  agentId: string;
  log?: (line: string) => void;
  onStatus?: (status: AgentStatus) => void;
  // Replaces this agent with a newer exe (see update.ts). Without one, as
  // when run from source, the agent does not offer to update itself.
  updater?: AgentUpdater;
  // Called once a newer agent has taken over; the process should exit.
  onReplaced?: () => void;
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
    features: options.updater ? [P.FEATURE_SELF_UPDATE] : [],
    ...options.info,
  };

  let stopped = false;
  let socket: WebSocket | null = null;
  let channel: P.SecureChannel | null = null;
  let backoff = 1000;
  let retryTimer: NodeJS.Timeout | null = null;
  let jobs: Promise<void> = Promise.resolve();
  // Set while a newer agent is taking over this PC.
  let handingOver = false;

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
      const found = await scanInstalled(env).catch((err: Error) => {
        log(`could not look for installed plugins: ${err.message}`);
        return [];
      });
      send({
        type: "state",
        state: {
          isAdmin: env.isAdmin,
          adobe: env.adobe.map((a) => ({ app: a.app, version: a.version })),
          blender: env.blender.map((b) => b.version),
          receipts: receipts.map((r) => ({
            id: r.id,
            version: r.version,
            installedAt: r.installedAt,
            ...(r.failed?.length ? { failed: r.failed.map((f) => f.part) } : {}),
          })),
          found,
        },
      });
    } catch (err) {
      log(`could not report state: ${(err as Error).message}`);
    }
  }

  // Streams a package zip or agent exe to disk, hashing as it goes, and
  // refuses it unless the hash is the one in the (authenticated) job message.
  async function download(path: string, sha256: string, file: string): Promise<string> {
    await mkdir(dirname(file), { recursive: true });
    const res = await fetch(base + path);
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
    if (actual !== sha256) {
      await rm(file, { force: true });
      throw new Error(`downloaded file does not match its SHA-256 (got ${actual})`);
    }
    return file;
  }

  // Hands this PC over to the downloaded agent. While that runs, a dropped
  // connection is not retried: the admin server drops it on purpose once
  // the new agent connects.
  async function updateSelf(file: string, version: string, jobLog: (line: string) => void): Promise<void> {
    if (!options.updater) throw new Error("this agent cannot update itself (it runs from source)");
    handingOver = true;
    try {
      await options.updater.replace(file, version, jobLog);
    } catch (err) {
      handingOver = false;
      if (!socket && !stopped) connect();
      throw err;
    }
  }

  function describe(job: P.JobSpec): string {
    if (job.action === "updateAgent") return `update agent ${info.agentVersion} to ${job.version} on ${info.hostname}`;
    return `${job.action} ${job.packageId}${job.action === "install" ? ` ${job.version}` : ""} on ${info.hostname}`;
  }

  async function runJob(job: P.JobSpec): Promise<void> {
    const jobLog = (line: string) => {
      log(line);
      send({ type: "jobLog", jobId: job.id, line });
    };
    send({ type: "jobStarted", jobId: job.id });
    jobLog(describe(job));

    let downloaded: string | null = null;
    let replaced = false;
    let partial: string[] = [];
    try {
      const env = await detect();
      const file = (stem: string, ext: string) => join(env.home, "downloads", `${stem}-${job.id.slice(0, 8)}${ext}`);
      if (job.action === "updateAgent") {
        downloaded = await download(job.downloadPath, job.sha256, file(`zeploy-agent-${job.version}`, ".exe"));
        await updateSelf(downloaded, job.version, jobLog);
        // No jobDone: the new agent finishes the job by connecting.
        replaced = true;
      } else {
        const exec: ExecuteOptions = { dryRun: false, ifRunning: job.options.ifRunning, log: jobLog, ...options.exec };
        if (job.action === "install") {
          downloaded = await download(job.downloadPath, job.sha256, file(`${job.packageId}-${job.version}`, ".zip"));
          const result = await installPackage(downloaded, env, {
            ...exec,
            expectedSha256: job.sha256,
            plan: { scope: job.options.scope, replaceDevLinks: job.options.replaceDevLinks },
          });
          // Installed in some Blender versions, failed in others: done, with the failures listed.
          partial = result.failed.map((f) => `${f.part}: ${f.error}`.slice(0, 2000));
        } else {
          await uninstallPackage(job.packageId, env, exec);
        }
        send({ type: "jobDone", jobId: job.id, ok: true, ...(partial.length ? { partial } : {}) });
      }
    } catch (err) {
      const message = (err as Error).message;
      jobLog(`error: ${message}`);
      send({ type: "jobDone", jobId: job.id, ok: false, error: message });
    } finally {
      if (downloaded) await rm(downloaded, { force: true });
    }
    if (replaced) {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      options.onReplaced?.();
      return;
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
      if (!stopped && !handingOver) {
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
