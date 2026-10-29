import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseClaudeCapabilities, publicClaudeModels, readCcSwitchState, ccSwitchReadiness } from "../agent/claude-status.mjs";
import { parseClaudeTranscript, createClaudeSession } from "../agent/claude-sessions.mjs";
import { claudeArgs, claudeEvent, sendClaudePrompt } from "../agent/claude-runner.mjs";
import { configureSessionRoots, listSessions, getSession } from "../agent/sessions.mjs";
import { RequestLedger } from "../agent/request-ledger.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaydesk-claude-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); return rm(root, { recursive: true, force: true }); });
  return root;
}
const id = "13f99f30-60e1-4be3-aea5-4a9149b14636";
const oldHelp = "--print --resume --output-format (stream-json) --permission-mode (dontAsk,plan) --allowedTools";

test("Claude feature detection keeps old clients usable without inventing an effort option", () => {
  const old = parseClaudeCapabilities(oldHelp, "2.0.0");
  assert.equal(old.resume && old.stream && old.permissions, true);
  assert.equal(old.effort, false);
  assert.deepEqual(old.reasoningEfforts, []);
  const modern = parseClaudeCapabilities(`${oldHelp}\n--effort <level> (low, medium, high)\n--file`, "2.1.0");
  assert.deepEqual(modern.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(parseClaudeCapabilities("--resume --print", "1.0").stream, false);
  assert.equal(parseClaudeCapabilities(oldHelp, "2.2.0").terminalControl, true);
  assert.equal(parseClaudeCapabilities(oldHelp, "3.0.0").liveMessaging, true);
  assert.equal(parseClaudeCapabilities(oldHelp, "2.1.311").terminalControl, false);
});

test("Claude history excludes thinking, tools' raw output and sidechain messages", () => {
  const parsed = parseClaudeTranscript([
    { type: "user", uuid: "u", message: { content: "你好" } },
    { type: "assistant", uuid: "a", message: { model: "actual-model", content: [{ type: "thinking", thinking: "private-reasoning" }, { type: "text", text: "你好！" }, { type: "tool_use", id: "t", name: "Read" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "private-file" }] } },
    { type: "assistant", isSidechain: true, message: { content: "subagent-internal" } },
  ]);
  assert.deepEqual(parsed.messages.map((row) => row.content), ["你好", "你好！"]);
  assert.equal(parsed.settings.model, "actual-model");
  assert.equal(parsed.activity[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(parsed), /private-reasoning|private-file|subagent-internal/);
});

test("Claude execution uses a specific session and explicit permissions and never puts the prompt in arguments", () => {
  const args = claudeArgs({ id }, {});
  assert.deepEqual(args.slice(0, 3), ["-p", "--resume", id]);
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(claudeArgs({ id, isNew: true }, { permission: "full" }).includes("--session-id"), true);
  assert.equal(claudeArgs({ id }, { permission: "full" }).includes("bypassPermissions"), true);
  assert.throws(() => claudeArgs({ id: "../session" }), /ID/);
  assert.throws(() => claudeArgs({ id }, { reasoning: "ultra" }), /思考/);
  assert.equal(claudeEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret" }] } }), null);
});

test("Claude model names derive from the live local mapping and never include credentials", () => {
  const models = publicClaudeModels({ env: { ANTHROPIC_AUTH_TOKEN: "private-key", ANTHROPIC_DEFAULT_SONNET_MODEL: "actual-upstream", ANTHROPIC_DEFAULT_FABLE_MODEL: "another-upstream" } });
  assert.equal(models.find((row) => row.model === "sonnet").displayName, "sonnet · actual-upstream");
  assert.equal(models.some((row) => row.model === "fable"), true);
  assert.doesNotMatch(JSON.stringify(models), /private-key|AUTH_TOKEN/);
});

test("CC Switch reads effective routing selection without changing unknown database versions or exposing configuration", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "cc-switch.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE providers (id TEXT,name TEXT,app_type TEXT,is_current INTEGER,sort_index INTEGER,settings_config TEXT); CREATE TABLE proxy_config (app_type TEXT,live_takeover_active INTEGER); PRAGMA user_version=99;");
  db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?)").run("one", "One", "claude", 1, 0, '{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"}}');
  db.prepare("INSERT INTO providers VALUES (?,?,?,?,?,?)").run("two", "Two", "claude", 0, 1, "{}");
  db.close();
  await writeFile(path.join(root, "settings.json"), JSON.stringify({ currentProviderClaude: "one" }));
  await writeFile(path.join(root, "live-state.json"), JSON.stringify({ apps: { claude: { mode: "proxy", attached: true, proxy_route: "two" } } }));
  const state = await readCcSwitchState(root);
  assert.equal(state.currentId, "two");
  assert.equal(state.providers.find((row) => row.id === "two").current, true);
  assert.match(await ccSwitchReadiness(state), /99.*未验证/);
  assert.doesNotMatch(JSON.stringify(state), /secret|AUTH_TOKEN|settings_config/);
  const verify = new DatabaseSync(file, { readOnly: true });
  assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 99); verify.close();
});

test("Claude discovery keeps provider namespaces distinct and reads normal history alongside Codex", async (t) => {
  const root = await temporary(t);
  const directory = path.join(root, "projects", "project"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.jsonl`), [
    { type: "user", uuid: "u", sessionId: id, cwd: root, message: { content: "测试" } },
    { type: "assistant", uuid: "a", sessionId: id, message: { model: "model", content: [{ type: "text", text: "回复" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  configureSessionRoots({ claudeHome: root }); t.after(() => configureSessionRoots());
  assert.equal((await listSessions(true)).some((session) => session.key === `claude:${id}`), true);
  const session = await getSession("claude", id);
  assert.deepEqual(session.messages.map((row) => row.content), ["测试", "回复"]);
});

test("global provider switch and Claude create requests cannot replay with a different target", async (t) => {
  const ledger = new RequestLedger(path.join(await temporary(t), "receipts.json")); await ledger.load();
  await ledger.claim("phone", { type: "ccswitch:switch", requestId: "switch", providerId: "one" });
  assert.equal((await ledger.claim("phone", { type: "ccswitch:switch", requestId: "switch", providerId: "one" })).claimed, false);
  await assert.rejects(ledger.claim("phone", { type: "ccswitch:switch", requestId: "switch", providerId: "two" }), /不一致/);
});

test("the Claude process adapter delivers once, persists a new conversation and rejects JSON failures even with exit code zero", async (t) => {
  const root = await temporary(t);
  const fake = path.join(root, "fake-claude.mjs");
  const keys = ["RELAYDESK_CLAUDE_EXECUTABLE", "RELAYDESK_STATE_DIR", "CLAUDE_CONFIG_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } configureSessionRoots(); });
  process.env.RELAYDESK_CLAUDE_EXECUTABLE = fake;
  process.env.RELAYDESK_STATE_DIR = path.join(root, "state");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  await writeFile(fake, `import {mkdir,appendFile} from 'node:fs/promises'; import path from 'node:path';
    const args=process.argv.slice(2);
    if(args.includes('--version')) {console.log('2.1.197 fixture');process.exit(0)}
    if(args.includes('--help')) {console.log('--print --resume --session-id --output-format stream-json --permission-mode dontAsk plan --allowedTools\\n--effort (low,medium,high)');process.exit(0)}
    let prompt='';for await(const chunk of process.stdin) prompt+=chunk;
    const id=args[args.findIndex(value=>value==='--session-id'||value==='--resume')+1];
    const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');await mkdir(dir,{recursive:true});
    await appendFile(path.join(dir,id+'.jsonl'),JSON.stringify({type:'user',uuid:Date.now()+'u',sessionId:id,cwd:process.cwd(),message:{content:prompt}})+'\\n');
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'fixture response'}]}}));
    console.log(JSON.stringify({type:'result',is_error:prompt==='fail',result:prompt==='fail'?'upstream rejected':'ok'}));
  `);
  configureSessionRoots({ claudeHome: process.env.CLAUDE_CONFIG_DIR });
  const session = await createClaudeSession(root);
  assert.equal((await getSession("claude", session.id)).isNew, true);
  const events = [];
  const run = await sendClaudePrompt(session, "hello", {}, (event) => events.push(event));
  await run.completed;
  assert.deepEqual(events.map((event) => event.text), ["fixture response"]);
  const resumed = await getSession("claude", session.id);
  assert.equal(Boolean(resumed.isNew), false);
  assert.deepEqual(resumed.messages.map((message) => message.content), ["hello"]);
  const failed = await sendClaudePrompt(resumed, "fail", {}, () => {});
  await assert.rejects(failed.completed, /upstream rejected/);
});
