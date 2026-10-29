import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveClaudeBinding } from "../agent/claude-live.mjs";
import { RequestLedger } from "../agent/request-ledger.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const started = 1700000000000;
const ticks = (unixMs) => String((BigInt(unixMs) + 11644473600000n) * 10000n);
const connection = { socket: "\\\\.\\pipe\\LOCAL\\cc-msg-selected", token: "fixture-token" };
const rows = [
  { sessionId: id, pid: 101, messagingSocketPath: connection.socket, procStart: ticks(started), startedAt: started + 6000 },
  { sessionId: id, pid: 102, messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-other", procStart: ticks(started + 5000), startedAt: started + 7000 },
];

test("parent and child processes for one Claude session select the bound socket even when hook PID capture failed", () => {
  const result = resolveClaudeBinding(id, connection, rows, "win32");
  assert.equal(result.target.pid, 101);
  assert.equal(result.connection.pid, 101);
  assert.equal(result.processCount, 2);
  assert.equal(result.connection.token, connection.token);
});
test("process birth comes from FILETIME rather than later session registration", () => {
  const result = resolveClaudeBinding(id, { ...connection, pid: 101, startedAt: rows[0].startedAt }, rows, "win32");
  assert.equal(result.connection.startedAt, started);
  assert.notEqual(result.connection.startedAt, rows[0].startedAt);
});
test("socket ownership wins over stale PID metadata and Windows socket casing is normalized", () => {
  const result = resolveClaudeBinding(id, { ...connection, socket: `uds:${connection.socket.toUpperCase()}`, pid: 102, startedAt: started + 5000 }, rows, "win32");
  assert.equal(result.connection.pid, 101);
  assert.equal(result.connection.startedAt, started);
});
test("a conflicting socket, another conversation, or genuinely ambiguous ownership never dispatches", () => {
  assert.throws(() => resolveClaudeBinding(id, { ...connection, socket: "missing", pid: 101 }, rows, "win32"), { code: "CLAUDE_TARGET_UNAVAILABLE", dispatched: false });
  assert.throws(() => resolveClaudeBinding("another-session", connection, rows, "win32"), /连接已失效/);
  assert.throws(() => resolveClaudeBinding(id, connection, [rows[0], { ...rows[1], messagingSocketPath: connection.socket }], "win32"), /多个 Claude/);
});
test("duplicate records for the same PID and older PID-only registries remain usable", () => {
  assert.equal(resolveClaudeBinding(id, connection, [rows[0], rows[0]], "win32").processCount, 1);
  const old = { ...connection, pid: 101, startedAt: started };
  assert.equal(resolveClaudeBinding(id, old, [{ sessionId: id, pid: 101 }], "win32").connection.startedAt, started);
});
test("the old known pre-dispatch error can be explicitly retried after restart, once per new attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaydesk-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "requests.json"), ledger = new RequestLedger(file);
  await ledger.load();
  const payload = { type: "session:send", provider: "claude", sessionId: id, requestId: "request", prompt: "进度" };
  await ledger.claim("phone", payload);
  await ledger.remember("phone", payload.requestId, { type: "request:error", requestId: payload.requestId, error: "无法确定唯一的 Claude 原进程，请刷新会话" });
  const recovered = new RequestLedger(file); await recovered.load();
  assert.equal(recovered.get("phone", payload.requestId).status, "failed");
  assert.equal((await recovered.claim("phone", payload)).claimed, false);
  const retry = { ...payload, retry: true, attemptId: "new-explicit-attempt" };
  assert.equal((await recovered.claim("phone", retry)).claimed, true);
  assert.equal((await recovered.claim("phone", retry)).claimed, false);
  await recovered.remember("phone", payload.requestId, { type: "request:error", status: "uncertain", error: "unknown delivery" });
  assert.equal((await recovered.claim("phone", { ...retry, attemptId: "another-attempt" })).claimed, false);
});
