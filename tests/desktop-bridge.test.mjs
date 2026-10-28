import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { probeDesktopBridge, sendDesktopPrompt } from "../agent/desktop-bridge.mjs";

const threadId = "01a152f0-3d0d-79b0-81d0-ccf47ff5b1f1";

async function fakeDesktop(t, handler) {
  const name = `relaydesk-test-${randomUUID()}`;
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE(0) + 4) return;
      const request = JSON.parse(buffer.subarray(4).toString("utf8"));
      const result = handler(request);
      if (result === undefined) return;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length);
      // Exercise partial headers and split UTF-8 payloads, as a real pipe can deliver them.
      socket.write(header.subarray(0, 2));
      setImmediate(() => { if (!socket.destroyed) socket.end(Buffer.concat([header.subarray(2), payload])); });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { pipePath, timeoutMs: 200 };
}

const catalog = { tools: ["read_thread", "send_message_to_thread"].map((name) => ({ name, namespace: "codex_app" })) };

test("desktop delivery targets the requested thread and preserves the exact prompt", async (t) => {
  const calls = [];
  const prompt = '今天周几？\n" & echo should-not-run | %PATH%';
  const options = await fakeDesktop(t, (request) => {
    calls.push(request);
    return request.method === "tools/list" ? catalog : { success: true, contentItems: [] };
  });
  const run = sendDesktopPrompt(threadId, prompt, options);
  assert.equal(run.supportsStop, false);
  assert.deepEqual(await run.completed, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.tool, "send_message_to_thread");
  assert.deepEqual(calls[1].params.arguments, { threadId, hostId: "local", prompt });
  assert.equal(calls[1].params.threadId, threadId);
});

test("the desktop probe reads the session without sending a message", async (t) => {
  const options = await fakeDesktop(t, (request) => {
    if (request.method === "tools/list") return catalog;
    assert.equal(request.params.tool, "read_thread");
    assert.equal(request.params.arguments.threadId, threadId);
    assert.equal(request.params.arguments.includeOutputs, false);
    return { success: true, contentItems: [] };
  });
  assert.deepEqual(await probeDesktopBridge(threadId, options), { ok: true });
});

test("desktop rejection is surfaced instead of reporting successful delivery", async (t) => {
  const options = await fakeDesktop(t, (request) => request.method === "tools/list" ? catalog : {
    success: false, contentItems: [{ type: "inputText", text: "会话暂时无法接收消息" }],
  });
  await assert.rejects(sendDesktopPrompt(threadId, "hello", options).completed, /会话暂时无法接收消息/);
});

test("a stalled desktop fails with a deadline and is never retried", async (t) => {
  let calls = 0;
  const options = await fakeDesktop(t, (request) => {
    if (request.method === "tools/list") return catalog;
    calls += 1;
    return undefined;
  });
  await assert.rejects(sendDesktopPrompt(threadId, "hello", options).completed, (error) => error.code === "DELIVERY_UNCERTAIN" && error.dispatched);
  assert.equal(calls, 1);
});

test("desktop sends can be cancelled and invalid thread IDs never connect", async (t) => {
  const options = await fakeDesktop(t, () => undefined);
  const run = sendDesktopPrompt(threadId, "hello", options);
  run.stop();
  await assert.rejects(run.completed, (error) => error.code === "CANCELLED");
  await assert.rejects(sendDesktopPrompt("invalid", "hello", options).completed, /会话 ID 无效/);
});

test("model and thinking overrides are sent to the same desktop conversation", async (t) => {
  const options = await fakeDesktop(t, (request) => {
    if (request.method === "tools/list") return catalog;
    assert.deepEqual(request.params.arguments, { threadId, hostId: "local", prompt: "hello", model: "gpt-6.1-sol", thinking: "high" });
    return { success: true, contentItems: [] };
  });
  await sendDesktopPrompt(threadId, "hello", { ...options, settings: { model: "gpt-6.1-sol", reasoning: "high" } }).completed;
});

test("an observed user turn confirms a stalled acknowledgement without resending", async (t) => {
  let dispatched = 0;
  const options = await fakeDesktop(t, (request) => {
    if (request.method === "tools/list") return catalog;
    dispatched += 1;
    return undefined;
  });
  const result = await sendDesktopPrompt(threadId, "hello", {
    ...options, confirmIntervalMs: 5, async confirmDelivery() { return dispatched === 1; },
  }).completed;
  assert.deepEqual(result, { ok: true, confirmedBy: "transcript" });
  assert.equal(dispatched, 1);
});
