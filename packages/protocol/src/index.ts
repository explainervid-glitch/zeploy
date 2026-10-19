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
]);

export const agentStateSchema = z.object({
  isAdmin: z.boolean(),
  adobe: z.array(z.object({ app: z.string(), version: z.string() })),
  blender: z.array(z.string()),
  receipts: z.array(z.object({ id: z.string(), version: z.string(), installedAt: z.string() })),
  // Plugins found in the install folders, installed by zeploy or not, keyed
  // like packages ("cep:com.colosave.panel"). Absent from agents before 0.4.0.
  found: z
    .array(z.object({ key: z.string().max(300), version: z.string().max(64).nullable(), where: z.string().max(200) }))
    .max(500)
    .optional(),
});

export const agentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: agentStateSchema }),
  z.object({ type: z.literal("jobStarted"), jobId: z.string() }),
  z.object({ type: z.literal("jobLog"), jobId: z.string(), line: z.string().max(4000) }),
  z.object({ type: z.literal("jobDone"), jobId: z.string(), ok: z.boolean(), error: z.string().max(8000).optional() }),
]);

export type JobOptions = z.infer<typeof jobOptionsSchema>;
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
