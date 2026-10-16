import assert from "node:assert/strict";
import { test } from "node:test";
import { helloMac, ProtocolError, SecureChannel, sessionKey, welcomeMac } from "../src/index.ts";

const key = sessionKey("team-token", "server-nonce-0000", "agent-nonce-0000");

test("a sealed message opens on the other side, in order", () => {
  const server = new SecureChannel(key, "server");
  const agent = new SecureChannel(key, "agent");
  assert.deepEqual(agent.open(server.seal({ type: "ping" })), { type: "ping" });
  assert.deepEqual(agent.open(server.seal({ type: "refresh" })), { type: "refresh" });
  assert.deepEqual(server.open(agent.seal({ type: "state" })), { type: "state" });
});

test("tampered, replayed and reflected messages are refused", () => {
  const server = new SecureChannel(key, "server");
  const agent = new SecureChannel(key, "agent");

  const wire = server.seal({ type: "job", job: { action: "uninstall" } });
  const tampered = wire.replace("uninstall", "install");
  assert.throws(() => agent.open(tampered), ProtocolError);

  agent.open(wire);
  assert.throws(() => agent.open(wire), /unexpected sequence/);

  // A message the agent sent, bounced back to it, must not pass as the server's.
  const own = new SecureChannel(key, "agent").seal({ type: "ping" });
  assert.throws(() => new SecureChannel(key, "agent").open(own), /bad message signature/);
});

test("a different token gives a different session key", () => {
  const other = new SecureChannel(sessionKey("wrong-token", "server-nonce-0000", "agent-nonce-0000"), "agent");
  assert.throws(() => other.open(new SecureChannel(key, "server").seal({ type: "ping" })), /bad message signature/);
});

test("handshake MACs depend on every input", () => {
  const base = helloMac("t", "n1", "agent-1", "a1");
  assert.notEqual(base, helloMac("t2", "n1", "agent-1", "a1"));
  assert.notEqual(base, helloMac("t", "n2", "agent-1", "a1"));
  assert.notEqual(base, helloMac("t", "n1", "agent-2", "a1"));
  assert.notEqual(welcomeMac("t", "n1", "a1"), welcomeMac("t", "a1", "n1"));
});
