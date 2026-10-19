// The admin server: package repository, agent connections and job dispatch.
//
// Two audiences share one port:
//   - agents on the LAN: WebSocket at /agent (authenticated, see protocol)
//     and /download/<job>?t=<one-time token> for the package zip;
//   - the admin UI on this computer only: static files and /api/*. These
//     answer loopback connections addressed to localhost, so another PC
//     cannot reach them and a web page cannot reach them through DNS
//     rebinding; /api/* also needs the per-run admin token.

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import * as P from "../../protocol/src/index.ts";
import { readAgentBuild, type AgentBuild } from "./agent-build.ts";
import { writeInstaller } from "./installer.ts";
import {
  compareSemver,
  HttpError,
  importPackage,
  inspectPackage,
  latestPackage,
  packagesDir,
  removePackage,
  backfillKeys,
} from "./packages.ts";
import { AGENT_PACKAGE_ID, MAX_JOB_LOG_LINES, Store, type AgentRecord, type JobRecord } from "./store.ts";

export interface ServerOptions {
  dataDir: string;
  // Default 7420; 0 picks a free port.
  port?: number;
  // Default: all interfaces, so agents on the LAN can connect.
  host?: string;
  // Folder holding the admin UI (index.html, app.js, style.css).
  uiDir?: string;
  // zeploy-agent.exe, copied next to the one-click installer it saves and
  // sent to agents that update themselves. Its version is read from the
  // zeploy-agent.json next to it.
  agentExe?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  adminToken: string;
  adminUrl: string;
  store: Store;
  close(): Promise<void>;
}

interface Conn {
  ws: WebSocket;
  channel: P.SecureChannel;
  agentId: string;
  busy: string | null;
  alive: boolean;
}

const MAX_UPLOAD_BYTES = 1024 ** 3;
const HEARTBEAT_MS = 20_000;
// How long an updated agent may take to connect after the old one dropped.
const RESTART_TIMEOUT_MS = 2 * 60_000;
const isActive = (job: JobRecord) => job.status === "queued" || job.status === "sent" || job.status === "running";
const UI_FILE = /^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$/i;
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

// 169.254.x.x is Windows' self-assigned fallback on an adapter without
// DHCP; no other PC can reach it, so it is never offered to agents.
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i!.address);
}

// What can be dropped on the admin UI: a package zip or a plugin file. The
// name becomes a file name in the staging folder, so no path characters.
const UPLOAD_NAME = /^[^\\/:*?"<>|]{1,120}\.(zip|zxp|ccx|jsx|jsxbin|jsfl|py)$/i;

const packageRequestSchema = z.object({
  path: z.string().min(1),
  // For a plugin without zeploy.json: details typed over the detected ones.
  overrides: z
    .object({
      id: z.string().max(100),
      name: z.string().max(200),
      version: z.string().max(64),
      extensionName: z.string().max(200),
    })
    .partial()
    .optional(),
});

const jobRequestSchema = z.object({
  action: z.enum(["install", "uninstall"]),
  packageId: z.string().min(1),
  version: z.string().optional(),
  agentIds: z.array(z.string()).min(1),
  options: P.jobOptionsSchema.partial().optional(),
});

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const store = await Store.open(options.dataDir);
  const adminToken = P.randomToken();
  const conns = new Map<string, Conn>();
  const downloads = new Map<string, { token: string; file: string; type: string }>();
  const sseClients = new Set<ServerResponse>();
  // Agent updates waiting for the new agent to connect, by job id.
  const restartTimers = new Map<string, NodeJS.Timeout>();
  let agentBuild: AgentBuild | null = null;
  let port = options.port ?? P.DEFAULT_PORT;
  // Files dropped on the UI but never added; nothing refers to them after a restart.
  const uploadsDir = join(store.dir, "staging", "uploads");
  await rm(uploadsDir, { recursive: true, force: true });

  // Jobs that were in flight when the server last stopped will never finish.
  for (const job of store.data.jobs) {
    if (job.status === "sent" || job.status === "running") {
      job.status = "failed";
      job.error = "admin server restarted during the job";
      job.finishedAt = new Date().toISOString();
    }
  }
  store.save();

  // ---- live updates for the UI ----------------------------------------------

  function snapshot() {
    return {
      enrollToken: store.data.enrollToken,
      port,
      addresses: lanAddresses(),
      installerReady: !!options.agentExe && existsSync(options.agentExe),
      // The agent version PCs can update to; null until the exe is hashed.
      agentBuild: agentBuild ? { version: agentBuild.version } : null,
      agents: Object.values(store.data.agents).map((a) => ({
        ...a,
        online: conns.has(a.id),
        busy: conns.get(a.id)?.busy ?? null,
      })),
      packages: store.data.packages,
      jobs: store.data.jobs
        .slice(-100)
        .reverse()
        .map(({ log: lines, ...rest }) => ({ ...rest, logCount: lines.length })),
    };
  }

  let stateTimer: NodeJS.Timeout | null = null;
  function changed(): void {
    store.save();
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of sseClients) res.write(data);
    }, 150);
  }

  function sendLog(jobId: string, line: string): void {
    const data = `event: log\ndata: ${JSON.stringify({ jobId, line })}\n\n`;
    for (const res of sseClients) res.write(data);
  }

  // Re-reads zeploy-agent.exe when it changed, as after npm run build.
  async function refreshAgentBuild(): Promise<AgentBuild | null> {
    const build = await readAgentBuild(options.agentExe, agentBuild);
    const differs = build?.version !== agentBuild?.version || build?.sha256 !== agentBuild?.sha256;
    agentBuild = build;
    if (differs) changed();
    return build;
  }

  // ---- jobs -------------------------------------------------------------------

  function finishJob(job: JobRecord, ok: boolean, error?: string): void {
    job.status = ok ? "done" : "failed";
    job.error = error;
    job.finishedAt = new Date().toISOString();
    downloads.delete(job.id);
    clearTimeout(restartTimers.get(job.id));
    restartTimers.delete(job.id);
    log(`job ${job.id.slice(0, 8)} ${job.action} ${job.packageId} on ${job.agentId.slice(0, 8)}: ${job.status}${error ? ` (${error.split("\n")[0]})` : ""}`);
  }

  function jobLine(job: JobRecord, line: string): void {
    if (job.log.length < MAX_JOB_LOG_LINES) job.log.push(line);
    sendLog(job.id, line);
  }

  // Why `agent` cannot be sent an update to agent `version`, or null.
  function updateRefusal(agent: AgentRecord, version: string): string | null {
    if (!agentBuild) return "zeploy-agent.exe is no longer next to the admin app";
    if (agentBuild.version !== version) return `the admin app now has agent ${agentBuild.version}; update again`;
    if (!agent.features?.includes(P.FEATURE_SELF_UPDATE)) {
      return `agent ${agent.agentVersion} cannot update itself; run the installer on this PC once`;
    }
    return null;
  }

  // Hands the agent its oldest queued job, if it is connected and idle.
  function pump(agentId: string): void {
    const conn = conns.get(agentId);
    if (!conn || conn.busy) return;
    const job = store.data.jobs.find((j) => j.agentId === agentId && j.status === "queued");
    if (!job) return;

    let spec: P.JobSpec;
    if (job.action === "install") {
      const pkg = store.data.packages.find((p) => p.id === job.packageId && p.version === job.version);
      if (!pkg) {
        finishJob(job, false, "package is no longer in the repository");
        changed();
        return pump(agentId);
      }
      const token = P.randomToken();
      downloads.set(job.id, { token, file: join(packagesDir(store), pkg.file), type: "application/zip" });
      spec = {
        id: job.id,
        action: "install",
        packageId: pkg.id,
        version: pkg.version,
        sha256: pkg.sha256,
        downloadPath: `/download/${job.id}?t=${token}`,
        options: job.options,
      };
    } else if (job.action === "updateAgent") {
      const agent = store.data.agents[agentId]!;
      if (agent.agentVersion === job.version) {
        // Updated some other way while the job waited, such as by the installer.
        jobLine(job, `the PC already runs agent ${job.version}`);
        finishJob(job, true);
        changed();
        return pump(agentId);
      }
      const refusal = updateRefusal(agent, job.version!);
      if (refusal || !agentBuild) {
        finishJob(job, false, refusal ?? undefined);
        changed();
        return pump(agentId);
      }
      const token = P.randomToken();
      downloads.set(job.id, { token, file: agentBuild.exe, type: "application/vnd.microsoft.portable-executable" });
      spec = {
        id: job.id,
        action: "updateAgent",
        version: agentBuild.version,
        sha256: agentBuild.sha256,
        downloadPath: `/download/${job.id}?t=${token}`,
      };
    } else {
      spec = { id: job.id, action: "uninstall", packageId: job.packageId, options: job.options };
    }
    job.status = "sent";
    conn.busy = job.id;
    conn.ws.send(conn.channel.seal({ type: "job", job: spec } satisfies P.ServerMessage));
    changed();
  }

  // ---- agents -------------------------------------------------------------------

  function onAgentConnected(conn: Conn, info: P.AgentInfo, address: string): void {
    const old = conns.get(conn.agentId);
    conns.set(conn.agentId, conn);
    old?.ws.terminate();
    const now = new Date().toISOString();
    const prev: AgentRecord | undefined = store.data.agents[conn.agentId];
    store.data.agents[conn.agentId] = {
      id: conn.agentId,
      label: prev?.label,
      hostname: info.hostname,
      user: info.user,
      agentVersion: info.agentVersion,
      features: info.features,
      address,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      state: prev?.state ?? null,
    };
    log(`agent ${info.hostname} (${info.user}) ${info.agentVersion} connected from ${address}`);
    // The job the previous connection was on: an agent update, which this
    // connection finishes, or a job nobody will report on any more.
    const pending = store.data.jobs.find((j) => j.agentId === conn.agentId && (j.status === "sent" || j.status === "running"));
    if (pending) settleOnReconnect(pending, info.agentVersion);
    changed();
    pump(conn.agentId);
  }

  function settleOnReconnect(job: JobRecord, agentVersion: string): void {
    if (job.action !== "updateAgent" || job.status !== "running") {
      finishJob(job, false, "agent reconnected during the job");
    } else if (agentVersion === job.version) {
      jobLine(job, `agent ${agentVersion} connected`);
      finishJob(job, true);
    } else {
      finishJob(job, false, `the PC came back with agent ${agentVersion}, not ${job.version}; its agent.log has the reason`);
    }
  }

  // The old agent's connection can drop before the new agent connects; the
  // update has failed only if the new one does not connect in time.
  function awaitRestart(job: JobRecord): void {
    const timer = setTimeout(() => {
      restartTimers.delete(job.id);
      if (job.status !== "running") return;
      finishJob(job, false, `the PC did not reconnect within ${RESTART_TIMEOUT_MS / 60_000} minutes of the agent update`);
      changed();
    }, RESTART_TIMEOUT_MS);
    timer.unref();
    restartTimers.set(job.id, timer);
  }

  function onAgentMessage(conn: Conn, msg: P.AgentMessage): void {
    const agent = store.data.agents[conn.agentId];
    if (agent) agent.lastSeen = new Date().toISOString();
    const job = "jobId" in msg ? store.data.jobs.find((j) => j.id === msg.jobId) : undefined;
    if ("jobId" in msg && (!job || job.agentId !== conn.agentId || conn.busy !== job.id)) return;

    switch (msg.type) {
      case "state":
        if (agent) agent.state = msg.state;
        break;
      case "jobStarted":
        job!.status = "running";
        job!.startedAt = new Date().toISOString();
        break;
      case "jobLog":
        jobLine(job!, msg.line);
        break;
      case "jobDone":
        finishJob(job!, msg.ok, msg.error);
        conn.busy = null;
        changed();
        pump(conn.agentId);
        return;
    }
    changed();
  }

  function onAgentClosed(conn: Conn): void {
    if (conns.get(conn.agentId) !== conn) return;
    conns.delete(conn.agentId);
    const job = conn.busy ? store.data.jobs.find((j) => j.id === conn.busy) : undefined;
    if (job?.action === "updateAgent" && job.status === "running") awaitRestart(job);
    else if (job) finishJob(job, false, "agent disconnected during the job");
    log(`agent ${store.data.agents[conn.agentId]?.hostname ?? conn.agentId} disconnected`);
    changed();
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  wss.on("connection", (ws, req) => {
    const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const nonce = P.randomToken();
    let conn: Conn | null = null;
    const timeout = setTimeout(() => conn || ws.close(4000, "handshake timeout"), 10_000);
    ws.send(JSON.stringify({ type: "challenge", protocol: P.PROTOCOL_VERSION, nonce } satisfies P.Challenge));

    ws.on("message", (data) => {
      const text = data.toString();
      if (!conn) {
        let hello: P.Hello;
        try {
          hello = P.helloSchema.parse(JSON.parse(text));
        } catch {
          ws.close(4002, "bad hello");
          return;
        }
        if (hello.protocol !== P.PROTOCOL_VERSION) {
          ws.close(4004, `protocol ${hello.protocol} not supported`);
          return;
        }
        const token = store.data.enrollToken;
        if (!P.safeEqual(hello.mac, P.helloMac(token, nonce, hello.agentId, hello.agentNonce))) {
          log(`rejected agent ${hello.info.hostname} from ${address}: wrong team token`);
          ws.close(4001, "wrong team token");
          return;
        }
        clearTimeout(timeout);
        ws.send(JSON.stringify({ type: "welcome", mac: P.welcomeMac(token, nonce, hello.agentNonce) } satisfies P.Welcome));
        conn = {
          ws,
          channel: new P.SecureChannel(P.sessionKey(token, nonce, hello.agentNonce), "server"),
          agentId: hello.agentId,
          busy: null,
          alive: true,
        };
        onAgentConnected(conn, hello.info, address);
        return;
      }
      let msg: P.AgentMessage;
      try {
        msg = P.agentMessageSchema.parse(conn.channel.open(text));
      } catch (err) {
        log(`closing agent ${conn.agentId}: ${(err as Error).message}`);
        ws.close(4003, "protocol error");
        return;
      }
      onAgentMessage(conn, msg);
    });
    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (conn) onAgentClosed(conn);
    });
    ws.on("error", () => {});
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
      conn.ws.send(conn.channel.seal({ type: "ping" } satisfies P.ServerMessage));
    }
    for (const res of sseClients) res.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);

  // ---- HTTP ---------------------------------------------------------------------

  function isAdminRequest(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const host = (req.headers.host ?? "").toLowerCase();
    return loopback && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
  }

  async function serveDownload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const jobId = url.pathname.slice("/download/".length);
    const entry = downloads.get(jobId);
    const token = url.searchParams.get("t") ?? "";
    if (!entry || !P.safeEqual(token, entry.token)) throw new HttpError(404, "no such download");
    const info = await stat(entry.file);
    res.writeHead(200, { "content-type": entry.type, "content-length": info.size });
    await pipeline(createReadStream(entry.file), res);
  }

  async function serveUi(res: ServerResponse, url: URL): Promise<void> {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!options.uiDir || !UI_FILE.test(name)) throw new HttpError(404, "not found");
    let body: Buffer | string = await readFile(join(options.uiDir, name)).catch(() => {
      throw new HttpError(404, "not found");
    });
    const ext = name.split(".").pop()!.toLowerCase();
    if (ext === "html") body = body.toString("utf8").replace("%%ADMIN_TOKEN%%", adminToken);
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  }

  // A file dropped on the admin UI in a browser, which cannot tell the server
  // its path. It keeps its name, which zeploy reads (a .jsx names its
  // package), and is added from there like any other path.
  async function receiveUpload(req: IncomingMessage, name: string): Promise<string> {
    if (!UPLOAD_NAME.test(name)) throw new HttpError(400, `cannot add ${name || "this file"}: not a package or plugin file`);
    const dir = join(uploadsDir, randomUUID());
    const file = join(dir, name);
    await mkdir(dir, { recursive: true });
    let size = 0;
    try {
      await pipeline(
        req,
        async function* (source) {
          for await (const chunk of source) {
            size += (chunk as Buffer).length;
            if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "file larger than 1 GB");
            yield chunk;
          }
        },
        createWriteStream(file),
      );
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return file;
  }

  function isUpload(path: string): boolean {
    const rel = relative(uploadsDir, path);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  }

  // An uploaded file is not needed once it is in the repository.
  async function dropUpload(path: string): Promise<void> {
    if (isUpload(path)) await rm(dirname(path), { recursive: true, force: true });
  }

  function createJobs(body: z.infer<typeof jobRequestSchema>): JobRecord[] {
    let version: string | undefined;
    if (body.action === "install") {
      const pkg = body.version
        ? store.data.packages.find((p) => p.id === body.packageId && p.version === body.version)
        : latestPackage(store, body.packageId);
      if (!pkg) throw new HttpError(404, `${body.packageId} ${body.version ?? ""} is not in the repository`.trim());
      version = pkg.version;
    }
    const unknown = body.agentIds.filter((id) => !store.data.agents[id]);
    if (unknown.length) throw new HttpError(400, `unknown agent(s): ${unknown.join(", ")}`);

    const jobOptions = P.jobOptionsSchema.parse(body.options ?? {});
    const created = body.agentIds.map((agentId) => {
      const job: JobRecord = {
        id: randomUUID(),
        agentId,
        action: body.action,
        packageId: body.packageId,
        version,
        options: jobOptions,
        status: "queued",
        createdAt: new Date().toISOString(),
        log: [],
      };
      store.data.jobs.push(job);
      return job;
    });
    changed();
    for (const agentId of body.agentIds) pump(agentId);
    return created;
  }

  // Queues an update to this admin's zeploy-agent.exe for each PC. Like any
  // job, it waits for a PC that is offline.
  async function createUpdateJobs(agentIds: string[]): Promise<JobRecord[]> {
    const build = await refreshAgentBuild();
    if (!build) {
      throw new HttpError(409, "zeploy-agent.exe or its zeploy-agent.json is missing; run npm run build, then npm run admin");
    }
    const agents = agentIds.map((id) => {
      const agent = store.data.agents[id];
      if (!agent) throw new HttpError(400, `unknown agent: ${id}`);
      return agent;
    });
    for (const agent of agents) {
      const name = agent.label ?? agent.hostname;
      if (compareSemver(agent.agentVersion, build.version) >= 0) {
        throw new HttpError(409, `${name} already runs agent ${agent.agentVersion}`);
      }
      if (!agent.features?.includes(P.FEATURE_SELF_UPDATE)) {
        throw new HttpError(409, `${name} runs agent ${agent.agentVersion}, which cannot update itself; run the installer on that PC once`);
      }
      if (store.data.jobs.some((j) => j.agentId === agent.id && j.action === "updateAgent" && isActive(j))) {
        throw new HttpError(409, `an agent update for ${name} is already on its way`);
      }
    }
    const created = agents.map((agent) => {
      const job: JobRecord = {
        id: randomUUID(),
        agentId: agent.id,
        action: "updateAgent",
        packageId: AGENT_PACKAGE_ID,
        version: build.version,
        options: P.jobOptionsSchema.parse({}),
        status: "queued",
        createdAt: new Date().toISOString(),
        log: [],
      };
      store.data.jobs.push(job);
      return job;
    });
    changed();
    for (const agent of agents) pump(agent.id);
    return created;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    const q = (name: string) => url.searchParams.get(name) ?? "";
    switch (route) {
      case "GET /api/state":
        return json(res, 200, snapshot());
      case "GET /api/events":
        return openEvents(req, res);
      case "GET /api/job": {
        const job = store.data.jobs.find((j) => j.id === q("id"));
        if (!job) throw new HttpError(404, "no such job");
        return json(res, 200, job);
      }
      case "POST /api/packages/inspect": {
        const { path, overrides } = packageRequestSchema.parse(await readJson(req));
        return json(res, 200, await inspectPackage(store, path, overrides));
      }
      case "POST /api/packages/import": {
        const { path, overrides } = packageRequestSchema.parse(await readJson(req));
        const { record, apps } = await importPackage(store, path, overrides, isUpload(path) ? undefined : path);
        await dropUpload(path);
        changed();
        return json(res, 200, { ...record, apps });
      }
      case "POST /api/packages/upload":
        return json(res, 200, { path: await receiveUpload(req, q("name")) });
      case "DELETE /api/packages":
        await removePackage(store, q("id"), q("version"));
        changed();
        return json(res, 200, { ok: true });
      case "POST /api/jobs":
        return json(res, 200, createJobs(jobRequestSchema.parse(await readJson(req))));
      case "POST /api/jobs/cancel": {
        const job = store.data.jobs.find((j) => j.id === q("id"));
        if (!job || job.status !== "queued") throw new HttpError(409, "only a queued job can be cancelled");
        finishJob(job, false, "cancelled");
        changed();
        return json(res, 200, { ok: true });
      }
      case "POST /api/installer": {
        const body = z.object({ folder: z.string().min(1), server: z.string().min(1) }).parse(await readJson(req));
        const saved = await writeInstaller(body.folder, {
          server: body.server,
          token: store.data.enrollToken,
          agentExe: options.agentExe,
        });
        log(`saved agent installer for ${body.server} to ${body.folder}`);
        return json(res, 200, saved);
      }
      case "POST /api/agents/update": {
        const { agentIds } = z.object({ agentIds: z.array(z.string()).min(1) }).parse(await readJson(req));
        return json(res, 200, await createUpdateJobs(agentIds));
      }
      case "POST /api/agents/refresh":
        for (const conn of conns.values()) conn.ws.send(conn.channel.seal({ type: "refresh" } satisfies P.ServerMessage));
        return json(res, 200, { ok: true });
      case "POST /api/agents/rename": {
        const body = z
          .object({ id: z.string(), label: z.string().trim().max(60, "keep the name to 60 characters") })
          .parse(await readJson(req));
        const agent = store.data.agents[body.id];
        if (!agent) throw new HttpError(404, "no such PC");
        // An empty name goes back to the Windows computer name.
        if (body.label) agent.label = body.label;
        else delete agent.label;
        changed();
        return json(res, 200, agent);
      }
      case "DELETE /api/agents": {
        const id = q("id");
        if (conns.has(id)) throw new HttpError(409, "the agent is online; it would only reappear");
        delete store.data.agents[id];
        changed();
        return json(res, 200, { ok: true });
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, protocol: P.PROTOCOL_VERSION });
    }
    if (req.method === "GET" && url.pathname.startsWith("/download/")) return serveDownload(req, res, url);

    if (!isAdminRequest(req)) throw new HttpError(403, "the admin interface is only available on the admin computer");
    if (url.pathname.startsWith("/api/")) {
      const token = req.headers["x-zeploy-admin"] ?? (url.pathname === "/api/events" ? url.searchParams.get("token") : null);
      if (typeof token !== "string" || !P.safeEqual(token, adminToken)) throw new HttpError(401, "missing admin token");
      return api(req, res, url);
    }
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    return serveUi(res, url);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : (err as Error).message;
      if (status === 500) log(`error on ${req.method} ${req.url}: ${(err as Error).stack ?? message}`);
      if (res.headersSent) res.destroy();
      else json(res, status, { error: message });
    });
  });

  http.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== P.AGENT_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  await new Promise<void>((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(port, options.host ?? "0.0.0.0", () => resolveListen());
  });
  const address = http.address();
  if (address && typeof address === "object") port = address.port;
  log(`zeploy admin server on port ${port} (LAN: ${lanAddresses().join(", ") || "no network"})`);

  // Hashing the agent exe takes a moment; the UI shows the update when done.
  const agentBuildLoaded = refreshAgentBuild().catch((err: Error) => log(`could not read the agent exe: ${err.message}`));
  const keysBackfilled = backfillKeys(store)
    .then((changedAny) => changedAny && changed())
    .catch((err: Error) => log(`could not read stored packages: ${err.message}`));

  return {
    port,
    adminToken,
    adminUrl: `http://127.0.0.1:${port}/`,
    store,
    async close() {
      clearInterval(heartbeat);
      if (stateTimer) clearTimeout(stateTimer);
      for (const res of sseClients) res.end();
      for (const conn of conns.values()) conn.ws.terminate();
      wss.close();
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections();
      });
      await agentBuildLoaded;
      await keysBackfilled;
      for (const timer of restartTimers.values()) clearTimeout(timer);
      if (stateTimer) clearTimeout(stateTimer);
      await store.flush();
    },
  };
}
