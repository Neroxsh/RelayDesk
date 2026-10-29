import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { InteractionBroker, claudeDecision } from "../agent/interactions.mjs";
import { CodexControl, applyDesktopPatches, codexPendingRequests } from "../agent/codex-control.mjs";
import { installClaudeHooks, claudeHookSettings } from "../agent/claude-live.mjs";
import { configureClaudeHome, parseClaudeTranscript } from "../agent/claude-sessions.mjs";
import { RequestLedger } from "../agent/request-ledger.mjs";
const id = "11111111-1111-4111-8111-111111111111";

async function temporary(t) { const root = await mkdtemp(path.join(os.tmpdir(), "relaydesk-interaction-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("approval broker rejects wrong sessions, validates every answer and resolves exactly once", async () => {
  const broker = new InteractionBroker();
  const pending = broker.ask({ id: "q", sessionId: id, tool: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } });
  assert.throws(() => broker.respond("other", "q", "answer", { "Which?": ["A"] }), /过期/);
  assert.throws(() => broker.respond(id, "q", "answer", {}), /所有问题/);
  assert.throws(() => broker.respond(id, "q", "answer", { "Which?": ["A", "B"] }), /所有问题/);
  assert.equal(broker.list(id).length, 1);
  broker.respond(id, "q", "answer", { "Which?": ["My own answer"] });
  assert.deepEqual((await pending).updatedInput.answers, { "Which?": "My own answer" });
  assert.throws(() => broker.respond(id, "q", "answer", { "Which?": ["A"] }), /过期/);
  assert.equal(broker.list(id).length, 0);
});

test("disconnection and expiration never become approval and plan mode changes are explicit", async () => {
  const broker = new InteractionBroker();
  const pending = broker.ask({ id: "tool", sessionId: id, tool: "Bash", input: { command: "echo fixture" } });
  broker.cancelSession(id); assert.equal(await pending, null);
  const denied = claudeDecision({ tool: "Bash", input: {} }, "deny"); assert.equal(denied.behavior, "deny");
  const normal = claudeDecision({ tool: "ExitPlanMode", input: { plan: "Only this plan" } }, "allow");
  assert.equal(normal.updatedPermissions[0].mode, "acceptEdits");
  assert.equal(claudeDecision({ tool: "ExitPlanMode", input: {} }, "allow", null, "full").updatedPermissions[0].mode, "bypassPermissions");
});

test("desktop patches preserve arrays and reject prototype pollution and missing paths", () => {
  const state = { requests: [{ id: 1 }], latestModel: "old" };
  applyDesktopPatches(state, [{ op: "add", path: ["requests", 1], value: { id: 2 } }, { op: "remove", path: ["requests", 0] }, { op: "replace", path: ["latestModel"], value: "new" }]);
  assert.equal(state.requests[0].id, 2); assert.equal(state.latestModel, "new");
  assert.throws(() => applyDesktopPatches(state, [{ op: "add", path: ["__proto__", "poison"], value: true }]), /无效/);
  assert.throws(() => applyDesktopPatches(state, [{ op: "add", path: ["missing", "leaf"], value: true }]), /重新同步/);
  assert.equal({}.poison, undefined);
});

test("only supported desktop approvals are offered and verification secrets stay on the computer", () => {
  const requests = codexPendingRequests({ requests: [
    { id: 17, method: "item/commandExecution/requestApproval", params: { command: "npm test", availableDecisions: ["accept", "decline"] } },
    { id: 18, method: "item/tool/requestUserInput", params: { questions: [{ id: "q", isSecret: true, question: "Password" }] } },
    { id: 19, method: "mcpServer/elicitation/request", params: { mode: "openai/userVerification", challenge: "SECRET" } },
  ] });
  assert.deepEqual(requests[0].choices, ["allow", "deny"]);
  assert.equal(requests[1].kind, "notice"); assert.equal(requests[2].kind, "notice");
  assert.doesNotMatch(JSON.stringify(requests), /SECRET|Password/);
});

test("desktop coordination reads snapshots, answers original numeric requests and rejects stale approvals", async (t) => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\relaydesk-control-test-${process.pid}-${Date.now()}` : path.join(await temporary(t), "ipc.sock");
  const received = [];
  const state = { requests: [{ id: 42, method: "item/commandExecution/requestApproval", params: { command: "npm test" } }], latestModel: "actual", latestReasoningEffort: "high", latestThreadSettings: { model: "actual", effort: "high", sandboxPolicy: { type: "workspaceWrite" } } };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    const send = (message) => { const bytes = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); socket.write(frame); };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const n = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4); received.push(message);
        if (message.type === "request") {
          send({ type: "response", requestId: message.requestId, method: message.method, resultType: "success", handledByClientId: "desktop", result: message.method === "initialize" ? { clientId: "phone-bridge" } : message.method === "thread-follower-update-thread-settings" ? { applied: true } : { ok: true } });
          if (message.method === "thread-follower-command-approval-decision") send({ type: "broadcast", version: 11, method: "thread-stream-state-changed", sourceClientId: "desktop", params: { hostId: "local", conversationId: id, change: { type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: ["requests"], value: [] }] } } });
        }
        if (message.type === "broadcast" && message.params.following) send({ type: "broadcast", version: 11, method: "thread-stream-state-changed", sourceClientId: "desktop", params: { hostId: "local", conversationId: id, change: { type: "snapshot", revision: 1, conversationState: structuredClone(state) } } });
      }
    });
  }); await new Promise((resolve) => server.listen(pipe, resolve));
  const client = new CodexControl({ pipePath: pipe, timeoutMs: 1000 });
  t.after(() => { client.close(); for (const socket of sockets) socket.destroy(); return new Promise((r) => server.close(r)); });
  const snapshot = await client.snapshot(id);
  assert.equal(snapshot.settings.model, "actual"); assert.equal(snapshot.pending.length, 1);
  await client.respond(id, "42", "allow");
  const call = received.find((m) => m.method === "thread-follower-command-approval-decision");
  assert.equal(call.params.requestId, 42); assert.equal(call.params.decision, "accept"); assert.equal(call.targetClientId, "desktop");
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(client.respond(id, "42", "allow"), /过期/);
  await client.setPermission(id, "read-only");
  const permissions = received.find((m) => m.method === "thread-follower-update-thread-settings"); assert.equal(permissions.params.threadSettings.approvalPolicy, "on-request");
  const liveState = client.states.get(id).state;
  liveState.latestThreadSettings.collaborationMode = { mode: "plan", settings: { model: "actual", reasoning_effort: "high" } };
  liveState.turns = [{ turnId: "plan-turn", status: "completed", turnStartedAtMs: 100 }];
  assert.equal((await client.snapshot(id)).planReady, true);
  await assert.rejects(client.acceptPlan(id, "stale-plan"), /状态已变化/);
  await client.acceptPlan(id, "plan-turn");
  assert.equal((await client.snapshot(id)).planReady, false);
  await assert.rejects(client.acceptPlan(id, "plan-turn"), /状态已变化|已提交/);
  const plan = received.find((m) => m.params?.threadSettings?.collaborationMode);
  assert.equal(plan.params.threadSettings.collaborationMode.mode, "default");
  assert.equal(received.some((m) => /start-turn|send.message/.test(m.method)), false);
});

test("hook setup preserves credentials and unrelated hooks, is repeatable, and uses executable argument arrays", async (t) => {
  const root = await temporary(t); configureClaudeHome(root); t.after(() => configureClaudeHome());
  await mkdir(root, { recursive: true }); const file = path.join(root, "settings.json");
  await writeFile(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: "private-test" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unrelated.exe" }] }] } }));
  await installClaudeHooks(); await installClaudeHooks();
  const result = JSON.parse(await readFile(file, "utf8"));
  assert.equal(result.env.ANTHROPIC_API_KEY, "private-test");
  assert.equal(result.hooks.SessionStart.length, 2);
  const hook = claudeHookSettings().SessionStart[0].hooks[0];
  assert.equal(hook.command, process.execPath); assert.equal(hook.args.length, 1); assert.equal(hook.onFailure, "continue");
});

test("RelayDesk peer messages reconcile as the original user text while other metadata stays hidden", () => {
  const parsed = parseClaudeTranscript([
    { type: "user", uuid: "phone-id", isMeta: true, origin: { kind: "peer", from: "RelayDesk" }, message: { content: "Another Claude session sent a message:\n我的问题\n\nThis came from another Claude session — internal peer policy" } },
    { type: "user", isMeta: true, origin: { kind: "peer", from: "other" }, message: { content: "hidden internal request" } },
  ]);
  assert.deepEqual(parsed.messages.map((m) => [m.id, m.content]), [["phone-id", "我的问题"]]);
});

test("approval and permission request receipts cannot replay with different decisions", async (t) => {
  const ledger = new RequestLedger(path.join(await temporary(t), "requests.json")); await ledger.load();
  const payload = { type: "interaction:respond", provider: "claude", sessionId: id, interactionId: "approval", decision: "allow", requestId: "r" };
  await ledger.claim("phone", payload); assert.equal((await ledger.claim("phone", payload)).claimed, false);
  await assert.rejects(ledger.claim("phone", { ...payload, decision: "deny" }), /不一致/);
});
