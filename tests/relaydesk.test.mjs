import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, sha256 } from "../agent/crypto.mjs";
import { parseCodexTranscript, readSessionTranscript } from "../agent/sessions.mjs";

test("desktop and phone derive the same end-to-end key", async () => {
  const desktop = await generateDeviceKeys();
  const phone = await generateDeviceKeys();
  const salt = sha256("ABCD-EFGH-JKLM-NPQR".replaceAll("-", ""));
  const desktopKey = await deriveSessionKey(desktop.privateKey, phone.publicKey, salt);
  const phoneKey = await deriveSessionKey(phone.privateKey, desktop.publicKey, salt);
  const envelope = await encryptJson(phoneKey, { type: "sessions:list", requestId: "test" });
  assert.deepEqual(await decryptJson(desktopKey, envelope), { type: "sessions:list", requestId: "test" });
});

test("Codex transcript exposes visible messages and safe live progress", () => {
  const rows = [
    { timestamp: "2026-07-19T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "修复页面" } },
    { timestamp: "2026-07-19T00:00:01Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-07-19T00:00:02Z", type: "event_msg", payload: { type: "agent_reasoning", text: "private reasoning" } },
    { timestamp: "2026-07-19T00:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "正在检查。" } },
    { timestamp: "2026-07-19T00:00:04Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call-1" } },
    { timestamp: "2026-07-19T00:00:05Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1" } },
    { timestamp: "2026-07-19T00:00:06Z", type: "event_msg", payload: { type: "patch_apply_end", changes: [{}, {}] } },
    { timestamp: "2026-07-19T00:00:07Z", type: "event_msg", payload: { type: "agent_message", message: "已经完成。" } },
    { timestamp: "2026-07-19T00:00:08Z", type: "event_msg", payload: { type: "task_complete", duration_ms: 8_000 } },
  ];
  const transcript = parseCodexTranscript(rows);
  assert.equal(transcript.state, "idle");
  assert.deepEqual(transcript.messages.map((message) => [message.role, message.content]), [
    ["user", "修复页面"],
    ["assistant", "正在检查。"],
    ["assistant", "已经完成。"],
  ]);
  assert.equal(transcript.messages.some((message) => message.content.includes("private reasoning")), false);
  assert.equal(transcript.activity.some((item) => item.label === "本机操作已完成"), true);
  assert.equal(transcript.activity.some((item) => item.label === "已更新 2 个文件"), true);
  assert.equal(transcript.activity.at(-1).label, "任务完成");
});

test("an unfinished Codex task remains visibly in progress", () => {
  const transcript = parseCodexTranscript([
    { timestamp: "2026-07-19T00:00:01Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-07-19T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "wait", call_id: "call-2" } },
  ]);
  assert.equal(transcript.state, "working");
  assert.equal(transcript.activity.at(-1).status, "running");
});

test("long Codex transcripts keep user context while new output is appended", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relaydesk-transcript-test-"));
  const file = path.join(directory, "session.jsonl");
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(file, [
      row({ timestamp: "2026-07-19T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "保留这条用户消息" } }),
      row({ timestamp: "2026-07-19T00:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "第一条回答" } }),
      row({ timestamp: "2026-07-19T00:00:02Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "large", output: "x".repeat(5 * 1024 * 1024) } }),
    ].join(""), "utf8");
    const initial = await readSessionTranscript("codex", file);
    assert.equal(initial.messages.some((message) => message.role === "user" && message.content === "保留这条用户消息"), true);

    await appendFile(file, row({ timestamp: "2026-07-19T00:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "追加后的回答" } }), "utf8");
    const updated = await readSessionTranscript("codex", file);
    assert.equal(updated.messages.some((message) => message.role === "user" && message.content === "保留这条用户消息"), true);
    assert.equal(updated.messages.at(-1).content, "追加后的回答");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the mobile UI keeps navigation and execution state within reach", async () => {
  const [page, browser, conversation, pairing, meta, css, manifest, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/session-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/conversation-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/pairing-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/relaydesk-meta.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_cuddly_mephistopheles.sql", import.meta.url), "utf8"),
  ]);
  assert.match(pairing, /16 位配对码/);
  assert.match(pairing, /fetchPairJson/);
  assert.match(pairing, /requestNonce/);
  assert.match(browser, /Codex/);
  assert.match(meta, /Claude Code/);
  assert.match(conversation, /返回会话列表/);
  assert.match(conversation, /回复会持续显示在这里/);
  assert.match(conversation, /发送后会排到当前任务后/);
  assert.match(conversation, /!session\.currentWindow && transcriptWorking/);
  assert.doesNotMatch(conversation, /disabled=\{!draft\.trim\(\) \|\| sending \|\| isWorking\}/);
  assert.match(conversation, /任务进行中/);
  assert.match(conversation, /需确认/);
  assert.match(conversation, /自动执行/);
  assert.match(conversation, /reply-pulse/);
  assert.match(page, /session:watch/);
  assert.match(page, /mergeSessionMessages/);
  assert.match(page, /attempt < 4/);
  assert.doesNotMatch(page, /consecutivePollFailures/);
  assert.match(meta, /export function mergeSessionMessages/);
  assert.match(page, /visibilitychange/);
  assert.match(page, /updateViaCache: "none"/);
  assert.match(css, /\.app-shell\.has-selection \.conversation-panel \{ position: fixed; inset: 0/);
  assert.match(css, /font-size: 16px/);
  assert.match(css, /@keyframes reply-dot/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  assert.match(migration, /pending_pairs/);
});

test("the public bridge retries transient EdgeOne read failures", async () => {
  const bridge = await readFile(new URL("../cloudflare-bridge/worker.js", import.meta.url), "utf8");
  assert.match(bridge, /TRANSIENT_ORIGIN_STATUS/);
  assert.match(bridge, /request\.method === "GET"/);
  assert.match(bridge, /attempts = safeToRetry \? 3 : 1/);
});

test("the agent persists and renews a selected-session subscription", async () => {
  const agent = await readFile(new URL("../agent/index.mjs", import.meta.url), "utf8");
  assert.match(agent, /\["session:get", "session:watch"\]/);
  assert.match(agent, /client\.watch = watch/);
  assert.match(agent, /subscriptions\.set\(clientId, \{ \.\.\.client\.watch, refreshedAt: Date\.now\(\) \}\)/);
  assert.match(agent, /Date\.now\(\) - lastExternalSyncAt < 3_000/);
  assert.match(agent, /async function sessionDetail/);
  assert.match(agent, /provider === "codex" && sessionId === "__current__"/);
  assert.match(agent, /stableSessionSnapshot/);
  assert.match(agent, /sendBestEffort/);
  assert.match(agent, /claimMutatingRequest/);
  assert.match(agent, /中继服务返回\\s\*5\\d\\d/);
});

test("the desktop bridge never exposes an arbitrary shell endpoint", async () => {
  const [agent, providers] = await Promise.all([
    readFile(new URL("../agent/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../agent/providers.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(agent, /payload\?\.type === ["']shell/);
  assert.match(agent, /payload\?\.type === "session:send"/);
  assert.match(agent, /prompt\.length > 12_000/);
  assert.match(agent, /message\.kind === "pair_request"/);
  assert.match(providers, /CommandType -eq 'Application'.*'\*\.cmd'/);
  assert.match(providers, /void completed\.catch/);
});

test("current-window injection is restricted to the Codex composer", async () => {
  const script = await readFile(new URL("../agent/codex-window.ps1", import.meta.url), "utf8");
  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /Current\.Name -eq "Codex"/);
  assert.match(script, /Current\.ClassName -like "ProseMirror\*"/);
  assert.match(script, /unsent text in its composer/);
  assert.match(script, /SendWait\("\{ENTER\}"\)/);
  assert.match(script, /OutputEncoding/);
  assert.match(script, /AllowUnavailable/);
  assert.doesNotMatch(script, /InvokePattern/);
});

test("the mainland entry runs the RelayDesk API on strongly consistent storage", async () => {
  const [proxy, prepare, pkg] = await Promise.all([
    readFile(new URL("../edgeone/edge-functions/api/[[default]].js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-edgeone.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(proxy, /@edgeone\/pages-blob/);
  assert.match(proxy, /consistency: "strong"/);
  assert.match(proxy, /DEVICE_ONLINE_WINDOW = 60_000/);
  assert.match(proxy, /requestNonce/);
  assert.match(proxy, /path === "\/api\/client\/send"/);
  assert.match(proxy, /path === "\/api\/agent\/import"/);
  assert.doesNotMatch(proxy, /chatgpt\.site/);
  assert.match(prepare, /missingAssets/);
  assert.match(prepare, /builtManifest/);
  assert.equal(JSON.parse(pkg).scripts["build:edgeone"].includes("prepare-edgeone.mjs"), true);
});
