// Talking to a PC's waker (packages/agent/src/waker.ts): the part of the
// agent that runs as SYSTEM from boot, so the admin can tell a PC that is
// on from one that is off while its agent is not running, start the agent,
// and read its log. See the protocol's "waker" section.

import type { z } from "zod";
import * as P from "../../protocol/src/index.ts";

export class WakerUnreachable extends Error {
  override name = "WakerUnreachable";
  // Something answered at that address, but not as this PC's waker.
  readonly answered: boolean;
  constructor(message: string, answered = false) {
    super(message);
    this.answered = answered;
  }
}

async function callOne<T>(
  host: string,
  port: number,
  token: string,
  agentId: string,
  action: P.WakerAction,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}${P.WAKER_PATH}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let nonce: string;
  try {
    const challenge = await fetch(`${base}/challenge`, { signal });
    nonce = ((await challenge.json()) as { nonce: string }).nonce;
    res = await fetch(`${base}/${action}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, nonce, mac: P.wakerRequestMac(token, action, agentId, nonce) }),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    throw new WakerUnreachable(e.name === "TimeoutError" ? "no answer" : (e.cause?.code ?? e.message));
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  // 404: another PC answers at that address now.
  if (!res.ok) throw new WakerUnreachable(json.error ?? `HTTP ${res.status}`, true);
  const reply = P.wakerReplySchema.parse(json);
  if (!P.safeEqual(reply.mac, P.wakerReplyMac(token, action, nonce, reply.body))) {
    throw new WakerUnreachable("the answer was not signed with the team token", true);
  }
  return schema.parse(JSON.parse(reply.body));
}

// Tries each address the PC may have (the one it last connected from, then
// its computer name), and gives the first answer. Failing, the error of an
// address where something answered says the most.
export async function callWaker<T>(
  hosts: string[],
  port: number,
  token: string,
  agentId: string,
  action: P.WakerAction,
  schema: z.ZodType<T>,
  timeoutMs = 3000,
): Promise<T> {
  const errors: Error[] = [];
  for (const host of [...new Set(hosts.filter(Boolean))]) {
    try {
      return await callOne(host, port, token, agentId, action, schema, timeoutMs);
    } catch (err) {
      errors.push(err as Error);
    }
  }
  throw errors.find((e) => e instanceof WakerUnreachable && e.answered) ?? errors[0] ?? new WakerUnreachable("no address");
}
