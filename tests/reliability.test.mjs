import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeTimelineMessages } from "../shared/messages.mjs";
import { parseCodexTranscript } from "../agent/sessions.mjs";
import { RequestLedger } from "../agent/request-ledger.mjs";
import { normalizeUsage, publicWindow } from "../agent/codex-status.mjs";
import { writeAtomicJson } from "../agent/persistence.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 9, 23, 0, 0, seconds)).toISOString();
const message = (id, role, content, seconds, extra = {}) => ({ id, role, content, timestamp: at(seconds), ...extra });

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relaydesk-reliability-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^relaydesk-reliability-/);
    return rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("a delayed user snapshot is placed before its answer and replaces the local echo", () => {
  const previous = [message("old", "assistant", "上一条回答", 0), message("answer", "assistant", "星期五", 3)];
  const incoming = [message("canonical", "user", "今天周几", 2), message("local-request", "user", "今天周几", 1, { pending: true })];
  assert.deepEqual(mergeTimelineMessages(previous, incoming).map((item) => item.id), ["old", "canonical", "answer"]);
});

test("repeated identical questions reconcile one-to-one rather than deleting a later request", () => {
  const canonical = [message("q1", "user", "继续", 1), message("a1", "assistant", "完成", 2)];
  const echoes = [message("local-1", "user", "继续", 1, { pending: true }), message("local-2", "user", "继续", 10, { pending: true })];
  assert.deepEqual(mergeTimelineMessages(canonical, echoes).map((item) => item.id), ["q1", "a1", "local-2"]);
});

test("overlapping snapshots do not duplicate messages or move earlier turns to the end", () => {
  const first = message("first", "user", "第一条", 1);
  const second = message("second", "assistant", "第一条回复", 2);
  const third = message("third", "user", "第二条", 3);
  assert.deepEqual(mergeTimelineMessages([second, third], [first, second, third]).map((item) => item.id), ["first", "second", "third"]);
});

test("forwarded desktop user messages coexist with event replies and metadata stays hidden", () => {
  const transcript = parseCodexTranscript([
    { timestamp: at(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_delegation><source_thread_id>origin</source_thread_id><input>今天周几</input></codex_delegation>" }] } },
    { timestamp: at(2), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "星期五" }] } },
    { timestamp: at(2), type: "event_msg", payload: { type: "agent_message", message: "星期五" } },
  ]);
  assert.deepEqual(transcript.messages.map((item) => [item.role, item.content]), [["user", "今天周几"], ["assistant", "星期五"]]);
});

test("the latest turn supplies actual model, thinking and permissions and interruption ends working state", () => {
  const transcript = parseCodexTranscript([
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high", sandbox_policy: { type: "danger-full-access" } } },
    { timestamp: at(1), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(2), type: "event_msg", payload: { type: "turn_aborted" } },
  ]);
  assert.equal(transcript.settings.model, "gpt-6.1-sol");
  assert.equal(transcript.settings.reasoning, "high");
  assert.equal(transcript.settings.permission, "full");
  assert.equal(transcript.state, "idle");
});

test("the desktop's actual function-call delivery format is shown as the original user message", () => {
  const transcript = parseCodexTranscript([
    { timestamp: at(1), type: "response_item", payload: { type: "function_call_output", call_id: "desktop-delivery", output: "<codex_delegation>\n<source_thread_id>01a152f0-3d0d-79b0-81d0-ccf47ff5b1f1</source_thread_id>\n<input>今天周几</input>\n</codex_delegation>" } },
    { timestamp: at(2), type: "event_msg", payload: { type: "agent_message", message: "星期五" } },
  ]);
  assert.deepEqual(transcript.messages.map((item) => [item.role, item.content]), [["user", "今天周几"], ["assistant", "星期五"]]);
});

test("unknown usage remains unknown and the desktop's multi-bucket limits take precedence", () => {
  const usage = normalizeUsage({
    accountId: "private-account", rateLimits: { primary: { usedPercent: 0 } },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 123 }, secondary: { usedPercent: 70 } } },
  });
  assert.equal(usage.primary.usedPercent, 20);
  assert.equal(usage.secondary.usedPercent, 70);
  assert.equal(publicWindow({ resetsAt: 123 }), null);
  assert.equal(publicWindow({ usedPercent: null }), null);
  assert.equal(JSON.stringify(usage).includes("private-account"), false);
});

const payload = { type: "session:send", provider: "codex", sessionId: "thread-id", prompt: "hello", requestId: "request-id" };

test("a completed delivery survives an agent restart and a replay never executes again", async (t) => {
  const filename = path.join(await temporaryDirectory(t), "requests.json");
  const first = new RequestLedger(filename);
  await first.load();
  assert.equal((await first.claim("phone", payload)).claimed, true);
  await first.remember("phone", payload.requestId, { type: "run:status", requestId: payload.requestId, status: "submitted" });
  const restarted = new RequestLedger(filename);
  await restarted.load();
  const replay = await restarted.claim("phone", payload);
  assert.equal(replay.claimed, false);
  assert.equal(replay.response.status, "submitted");
  assert.equal((await restarted.claim("other-phone", payload)).claimed, true);
});

test("a crash during dispatch restores an uncertain receipt instead of resending", async (t) => {
  const filename = path.join(await temporaryDirectory(t), "requests.json");
  const first = new RequestLedger(filename);
  await first.load();
  await first.claim("phone", payload);
  const restarted = new RequestLedger(filename);
  await restarted.load();
  const replay = await restarted.claim("phone", payload);
  assert.equal(replay.claimed, false);
  assert.equal(replay.response.status, "uncertain");
  await assert.rejects(restarted.claim("phone", { ...payload, prompt: "different" }), /内容不一致/);
});

test("only a new explicit retry attempt can re-run a known failed delivery", async (t) => {
  const ledger = new RequestLedger(path.join(await temporaryDirectory(t), "requests.json"));
  await ledger.load();
  await ledger.claim("phone", payload);
  await ledger.remember("phone", payload.requestId, { status: "failed" });
  assert.equal((await ledger.claim("phone", payload)).claimed, false);
  const retry = { ...payload, retry: true, attemptId: "new-attempt" };
  assert.equal((await ledger.claim("phone", retry)).claimed, true);
  await ledger.remember("phone", payload.requestId, { status: "failed" });
  assert.equal((await ledger.claim("phone", retry)).claimed, false);
});

test("atomic persistence keeps a valid preceding configuration backup", async (t) => {
  const filename = path.join(await temporaryDirectory(t), "config.json");
  await writeAtomicJson(filename, { identity: "same-device", clients: ["phone"] }, { backup: true });
  await writeAtomicJson(filename, { identity: "same-device", clients: ["phone", "tablet"] }, { backup: true });
  assert.deepEqual(JSON.parse(await readFile(`${filename}.bak`, "utf8")), { identity: "same-device", clients: ["phone"] });
  assert.equal(JSON.parse(await readFile(filename, "utf8")).clients.length, 2);
});
