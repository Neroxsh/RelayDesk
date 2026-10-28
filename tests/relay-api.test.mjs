import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const clientToken = "fixture-client-token";
const agentToken = "fixture-agent-token";
const hash = (value) => createHash("sha256").update(value).digest("hex");

function d1(sqlite) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        sql,
        bind(...values) { bindings = values; return this; },
        first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
        all() { return { results: sqlite.prepare(sql).all(...bindings) }; },
        run() {
          const result = sqlite.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => /^\s*(SELECT|PRAGMA)/i.test(statement.sql) ? statement.all() : statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

async function fixture(t, { legacy = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  if (legacy) sqlite.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, sender_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, envelope TEXT NOT NULL, created_at INTEGER NOT NULL)");
  globalThis.__relaydeskTestDB = { DB: d1(sqlite) };
  const result = await build({
    stdin: {
      contents: [
        'export {ensureSchema} from "./app/api/_lib/store.ts";',
        'export {POST as clientSend} from "./app/api/client/send/route.ts";',
        'export {POST as agentSend} from "./app/api/agent/send/route.ts";',
        'export {GET as agentPoll} from "./app/api/agent/poll/route.ts";',
        'export {GET as clientPoll} from "./app/api/client/poll/route.ts";',
      ].join("\n"), resolveDir: root, loader: "ts",
    },
    bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "isolated-d1", setup(plugin) {
      plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "fixture", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const env = globalThis.__relaydeskTestDB;", loader: "js" }));
    } }],
  });
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${randomUUID()}`);
  await api.ensureSchema();
  sqlite.prepare("INSERT INTO devices(id,name,platform,agent_token_hash,public_key,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?)")
    .run("device001", "fixture", "windows", hash(agentToken), "{}", Date.now(), Date.now());
  sqlite.prepare("INSERT INTO clients(id,device_id,token_hash,public_key,created_at,last_seen_at) VALUES(?,?,?,?,?,?)")
    .run("phone001", "device001", hash(clientToken), "{}", Date.now(), Date.now());
  const request = (endpoint, token, body) => new Request(`http://fixture${endpoint}`, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { sqlite, api, request };
}

test("the live relay SQL migrates legacy queues and coalesces client retries", async (t) => {
  const { sqlite, api, request } = await fixture(t, { legacy: true });
  const body = { deliveryId: "request001", envelope: { v: 1, ciphertext: "encrypted-fixture" } };
  const first = await (await api.clientSend(request("/api/client/send", clientToken, body))).json();
  const retry = await (await api.clientSend(request("/api/client/send", clientToken, body))).json();
  assert.equal(first.id, retry.id);
  assert.equal(sqlite.prepare("SELECT count(*) AS total FROM messages").get().total, 1);
  assert.equal(sqlite.prepare("PRAGMA table_info(messages)").all().some((column) => column.name === "delivery_id"), true);
});

test("acknowledging a queue does not erase the ability to retry delivery after a restart", async (t) => {
  const { api, request } = await fixture(t);
  const body = { deliveryId: "request001", envelope: { v: 1, ciphertext: "encrypted-fixture" } };
  const first = await (await api.clientSend(request("/api/client/send", clientToken, body))).json();
  await api.agentPoll(request(`/api/agent/poll?after=${first.id}`, agentToken));
  const retry = await (await api.clientSend(request("/api/client/send", clientToken, body))).json();
  assert.ok(retry.id > first.id);
  // The durable desktop receipt ledger, tested separately, prevents re-execution.
});

test("background refreshes no longer discard a request after thirty queued updates", async (t) => {
  const { api, request } = await fixture(t);
  for (let index = 0; index < 45; index++) {
    const response = await api.clientSend(request("/api/client/send", clientToken, { deliveryId: `request-${index}`, envelope: { ciphertext: `encrypted-${index}` } }));
    assert.equal(response.status, 200);
  }
  const response = await (await api.agentPoll(request("/api/agent/poll?after=0", agentToken))).json();
  assert.equal(response.messages.length, 45);
  assert.equal(JSON.parse(response.messages[0].envelope).ciphertext, "encrypted-0");
});

test("desktop response retries coalesce and invalid or unauthenticated writes stay rejected", async (t) => {
  const { sqlite, api, request } = await fixture(t);
  const body = { clientId: "phone001", deliveryId: "event0001", envelope: { v: 1, ciphertext: "reply" } };
  const first = await (await api.agentSend(request("/api/agent/send", agentToken, body))).json();
  const retry = await (await api.agentSend(request("/api/agent/send", agentToken, body))).json();
  assert.equal(first.id, retry.id);
  assert.equal(sqlite.prepare("SELECT count(*) AS total FROM messages").get().total, 1);
  assert.equal((await api.agentSend(request("/api/agent/send", "wrong", body))).status, 401);
  assert.equal((await api.clientSend(request("/api/client/send", clientToken, { ...body, deliveryId: "invalid!" }))).status, 400);
});
