// The wire protocol between the admin server and the agents on the team's PCs.
//
// Everything travels over plain WebSocket/HTTP on the LAN, and an agent runs
// installs with administrator rights, so messages are authenticated:
//
//   1. server -> agent  challenge {nonce}
//   2. agent  -> server hello {agentId, agentNonce, mac}  proves the agent knows the team token
//   3. server -> agent  welcome {mac}                      proves the server knows it too
//
// The token itself never crosses the wire. Both sides then derive a session
// key from the two nonces, and every later message is an envelope whose MAC
// covers a direction tag, a sequence number and the exact body text, so a
// message cannot be forged, altered, replayed or reflected back.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7420;
export const AGENT_PATH = "/agent";

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmac(key: string | Buffer, text: string): string {
  return createHmac("sha256", key).update(text).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---- handshake -------------------------------------------------------------

export const challengeSchema = z.object({
  type: z.literal("challenge"),
  protocol: z.number(),
  nonce: z.string().min(16),
});

// What an agent can do beyond the jobs every agent understands. The server
// only sends a job to an agent that lists its feature, so an older agent
// never receives a message it cannot parse.
export const FEATURE_SELF_UPDATE = "self-update";
// Connects to several admin computers and takes "admins" messages (0.7.0).
export const FEATURE_ADMINS = "admins";
// Reports plugin usage and takes "settings" and "usageAck" messages (0.8.0).
export const FEATURE_USAGE = "usage";
// Comes with the waker (see "waker" below), and reports problems (0.9.0).
export const FEATURE_WAKER = "waker";

export const agentInfoSchema = z.object({
  hostname: z.string().max(256),
  user: z.string().max(256),
  agentVersion: z.string().max(64),
  // Absent from agents before 0.3.0.
  features: z.array(z.string().max(32)).max(16).optional(),
});

export const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number(),
  agentId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  agentNonce: z.string().min(16),
  info: agentInfoSchema,
  mac: z.string(),
});

export const welcomeSchema = z.object({ type: z.literal("welcome"), mac: z.string() });

export type Challenge = z.infer<typeof challengeSchema>;
export type Hello = z.infer<typeof helloSchema>;
export type Welcome = z.infer<typeof welcomeSchema>;
export type AgentInfo = z.infer<typeof agentInfoSchema>;

export function helloMac(token: string, nonce: string, agentId: string, agentNonce: string): string {
  return hmac(token, `hello:${nonce}:${agentId}:${agentNonce}`);
}

export function welcomeMac(token: string, nonce: string, agentNonce: string): string {
  return hmac(token, `welcome:${agentNonce}:${nonce}`);
}

export function sessionKey(token: string, nonce: string, agentNonce: string): Buffer {
  return createHmac("sha256", token).update(`session:${nonce}:${agentNonce}`).digest();
}

// ---- authenticated envelopes -----------------------------------------------

export type Role = "server" | "agent";

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const envelopeSchema = z.object({ seq: z.number().int().nonnegative(), body: z.string(), mac: z.string() });

// One per connection and side. seal() numbers outgoing messages; open()
// insists on the next number from the other side.
export class SecureChannel {
  readonly #key: Buffer;
  readonly #me: Role;
  readonly #peer: Role;
  #sendSeq = 0;
  #recvSeq = 0;

  constructor(key: Buffer, me: Role) {
    this.#key = key;
    this.#me = me;
    this.#peer = me === "server" ? "agent" : "server";
  }

  seal(message: unknown): string {
    const body = JSON.stringify(message);
    const seq = this.#sendSeq++;
    return JSON.stringify({ seq, body, mac: hmac(this.#key, `${this.#me}:${seq}:${body}`) });
  }

  open(wire: string): unknown {
    let env: z.infer<typeof envelopeSchema>;
    try {
      env = envelopeSchema.parse(JSON.parse(wire));
    } catch {
      throw new ProtocolError("malformed envelope");
    }
    if (!safeEqual(env.mac, hmac(this.#key, `${this.#peer}:${env.seq}:${env.body}`))) {
      throw new ProtocolError("bad message signature");
    }
    if (env.seq !== this.#recvSeq) throw new ProtocolError(`unexpected sequence ${env.seq}, wanted ${this.#recvSeq}`);
    this.#recvSeq++;
    return JSON.parse(env.body);
  }
}

// ---- messages after the handshake ------------------------------------------

export const ifRunningSchema = z.enum(["fail", "kill", "ignore"]);

export const jobOptionsSchema = z.object({
  ifRunning: ifRunningSchema.default("fail"),
  replaceDevLinks: z.boolean().default(false),
  scope: z.enum(["auto", "user", "system"]).default("auto"),
});

export const jobSpecSchema = z.discriminatedUnion("action", [
  z.object({
    id: z.string(),
    action: z.literal("install"),
    packageId: z.string(),
    version: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    // Server-relative URL of the zip, valid for this job only.
    downloadPath: z.string().startsWith("/download/"),
    options: jobOptionsSchema,
  }),
  z.object({
    id: z.string(),
    action: z.literal("uninstall"),
    packageId: z.string(),
    options: jobOptionsSchema,
  }),
  // Replace the agent with a newer zeploy-agent.exe. Only for agents with
  // FEATURE_SELF_UPDATE. The new agent finishes the job by connecting with
  // `version`; the old one sends jobDone only when the update failed.
  z.object({
    id: z.string(),
    action: z.literal("updateAgent"),
    version: z.string().max(64),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    downloadPath: z.string().startsWith("/download/"),
  }),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job"), job: jobSpecSchema }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("ping") }),
  // Other admin computers of the team ("http://192.168.1.80:7420") to
  // connect to as well, or to stop connecting to. Only for agents with
  // FEATURE_ADMINS. Only addresses cross the wire: every admin of a team
  // uses the same team token, which each agent already has.
  z.object({
    type: z.literal("admins"),
    add: z.array(z.string().max(300)).max(16),
    remove: z.array(z.string().max(300)).max(64),
  }),
  // Sent when an agent with FEATURE_USAGE connects and when it changes:
  // whether this admin wants plugin usage reports.
  z.object({ type: z.literal("settings"), usage: z.boolean() }),
  // The usage batch with this id is stored; the agent may delete it.
  z.object({ type: z.literal("usageAck"), id: z.string().max(64) }),
]);

// Plugin usage, counted on the PC from the lines plugins append to
// %LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl (see docs/plugin-usage.md) and
// sent as one row per day and plugin. No user names, file names or messages:
// only the plugin's own id, version, app, and short event names.
const usageName = z.string().regex(/^[A-Za-z0-9._ -]{1,40}$/);
export const usageRowSchema = z.object({
  // The PC's local date of the events: "2026-10-20".
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // The plugin's own id: CEP bundle id, Blender module or extension id, or
  // script file name ("com.colosave.panel", "remaper", "Aegroup.jsx").
  plugin: z.string().min(1).max(120),
  app: z.string().max(40).optional(),
  opens: z.number().int().nonnegative(),
  // Features used, by name: how often, and their total duration in ms.
  actions: z.record(usageName, z.object({ n: z.number().int().nonnegative(), ms: z.number().nonnegative() })),
  errors: z.record(usageName, z.number().int().nonnegative()),
  // Events per plugin version.
  versions: z.record(z.string().max(32), z.number().int().nonnegative()),
  // The latest event of the day, ISO time.
  last: z.string().max(40),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

// "192.168.1.10", "192.168.1.10:7420" and "http://192.168.1.10:7420/" all
// become "http://192.168.1.10:7420".
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (!parsed.port) parsed.port = String(DEFAULT_PORT);
  return `${parsed.protocol}//${parsed.host}`;
}

export const adminLinkSchema = z.object({
  url: z.string().max(300),
  status: z.enum(["connecting", "connected", "disconnected", "rejected"]),
  // The admin this report is sent to.
  current: z.boolean().optional(),
});
export type AdminLink = z.infer<typeof adminLinkSchema>;

export const problemSchema = z.object({ at: z.string().max(40), message: z.string().max(500) });
export type Problem = z.infer<typeof problemSchema>;

export const agentStateSchema = z.object({
  isAdmin: z.boolean(),
  adobe: z.array(z.object({ app: z.string(), version: z.string() })),
  blender: z.array(z.string()),
  receipts: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      installedAt: z.string(),
      // Parts that failed in a partial install ("Blender 4.5"). From agent 0.5.0.
      failed: z.array(z.string().max(100)).max(20).optional(),
    }),
  ),
  // Plugins found in the install folders, installed by zeploy or not, keyed
  // like packages ("cep:com.colosave.panel"). Absent from agents before 0.4.0.
  found: z
    .array(z.object({ key: z.string().max(300), version: z.string().max(64).nullable(), where: z.string().max(200) }))
    .max(500)
    .optional(),
  // Every admin computer this agent connects to, and how that is going.
  // From agent 0.7.0.
  admins: z.array(adminLinkSchema).max(16).optional(),
  // What went wrong in the agent lately (the last day), newest first. From agent 0.9.0.
  problems: z.array(problemSchema).max(10).optional(),
  // Whether the waker runs on this PC, or why it could not be set up. From agent 0.9.0.
  waker: z.object({ running: z.boolean(), error: z.string().max(500).optional() }).optional(),
});

export const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: agentStateSchema }),
  z.object({ type: z.literal("jobStarted"), jobId: z.string() }),
  // Plugin usage since the last batch; answered with usageAck. From agent 0.8.0.
  z.object({ type: z.literal("usage"), id: z.string().max(64), rows: z.array(usageRowSchema).max(500) }),
  z.object({ type: z.literal("jobLog"), jobId: z.string(), line: z.string().max(4000) }),
  z.object({
    type: z.literal("jobDone"),
    jobId: z.string(),
    ok: z.boolean(),
    error: z.string().max(8000).optional(),
    // ok with parts that failed ("Blender 4.5: ..."): installed partly. From agent 0.5.0.
    partial: z.array(z.string().max(2000)).max(20).optional(),
  }),
]);

export type JobOptions = z.infer<typeof jobOptionsSchema>;
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;

// ---- waker -------------------------------------------------------------------
//
// The agent runs as the signed-in user and stops when they sign out or it
// crashes; then nothing on the PC answers the admin. The waker is the same
// zeploy-agent.exe run as SYSTEM from boot (`zeploy-agent waker`). It
// answers on WAKER_PORT, over plain HTTP:
//
//   GET  /waker            {waker: true, version}   (for the agent on the same PC)
//   GET  /waker/challenge  {nonce}                  single use, for one minute
//   POST /waker/<action>   {agentId, nonce, mac}    action: status, wake or log
//     -> {body, mac}       body is the action's reply as JSON text
//
// The request MAC proves the admin knows the team token and names the PC it
// means; the reply MAC proves the answer comes from that PC's waker.

export const WAKER_PORT = 7425;
export const WAKER_PATH = "/waker";

export const wakerActionSchema = z.enum(["status", "wake", "log"]);
export type WakerAction = z.infer<typeof wakerActionSchema>;

export const wakerRequestSchema = z.object({
  agentId: z.string().max(64),
  nonce: z.string().min(16).max(64),
  mac: z.string().max(128),
});

export function wakerRequestMac(token: string, action: WakerAction, agentId: string, nonce: string): string {
  return hmac(token, `waker:${action}:${agentId}:${nonce}`);
}

export function wakerReplyMac(token: string, action: WakerAction, nonce: string, body: string): string {
  return hmac(token, `waker-reply:${action}:${nonce}:${body}`);
}

export const wakerReplySchema = z.object({ body: z.string(), mac: z.string() });

export const wakerStatusSchema = z.object({
  agentId: z.string(),
  // The waker's own version.
  version: z.string().max(64),
  agentRunning: z.boolean(),
  // Whether the user the agent runs as is signed in: the agent can only start then.
  signedIn: z.boolean(),
  // The agent stopped with this error and has not connected since.
  crash: z.object({ at: z.string().max(40), error: z.string().max(2000) }).optional(),
});
export type WakerStatus = z.infer<typeof wakerStatusSchema>;

export const wakerWakeSchema = z.object({ started: z.boolean(), message: z.string().max(500) });
export type WakerWake = z.infer<typeof wakerWakeSchema>;

// The end of agent.log.
export const wakerLogSchema = z.object({ text: z.string(), file: z.string().max(400) });
export type WakerLog = z.infer<typeof wakerLogSchema>;
