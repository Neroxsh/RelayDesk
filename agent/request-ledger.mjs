import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeAtomicJson } from "./persistence.mjs";

const MUTATIONS = new Set(["session:send", "session:activate", "session:stop", "session:permission", "session:execute-plan", "interaction:respond", "claude:connect", "claude:create", "ccswitch:switch"]);
const RETENTION = 24 * 60 * 60_000;

export class RequestLedger {
  constructor(filename) { this.filename = filename; this.records = new Map(); this.write = Promise.resolve(); }
  async load() {
    let saved = {};
    try { saved = JSON.parse(await readFile(this.filename, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw new Error("消息回执记录不可读；已暂停发送以避免重复执行"); }
    for (const [key, record] of Object.entries(saved)) {
      if (record.expiresAt <= Date.now()) continue;
      // Previous agents returned this pre-dispatch validation failure without a
      // status. Preserve deduplication, but let the user explicitly retry it once
      // after upgrading. Unknown or uncertain errors remain non-retryable.
      if (record.response?.type === "request:error" && record.response.status == null && record.response.error === "无法确定唯一的 Claude 原进程，请刷新会话") {
        record.response = { ...record.response, status: "failed" };
      }
      if (["received", "running"].includes(record.response?.status)) {
        record.response = { ...record.response, status: "uncertain", error: "代理已恢复，正在核实此前消息，请勿重复发送" };
      }
      this.records.set(key, record);
    }
  }
  async flush() {
    for (const [key, record] of this.records) if (record.expiresAt <= Date.now()) this.records.delete(key);
    const snapshot = Object.fromEntries([...this.records].filter(([, record]) => record.expiresAt > Date.now()));
    this.write = this.write.catch(() => undefined).then(() => writeAtomicJson(this.filename, snapshot, { backup: true }));
    await this.write;
  }
  async claim(clientId, payload) {
    if (!MUTATIONS.has(payload?.type) || !payload?.requestId) return true;
    const key = `${clientId}:${payload.requestId}`;
    const fields = [payload.type, payload.provider, payload.sessionId, payload.prompt, payload.settings];
    if (["session:permission", "interaction:respond"].includes(payload.type)) fields.push(payload.permission, payload.interactionId, payload.decision, payload.answers);
    if (payload.type === "session:execute-plan") fields.push(payload.planId);
    if (["claude:create", "ccswitch:switch"].includes(payload.type)) fields.push(payload.providerId, payload.cwd);
    const fingerprint = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const existing = this.records.get(key);
    if (existing?.expiresAt > Date.now()) {
      if (existing.fingerprint !== fingerprint) throw new Error("消息标识重复且内容不一致");
      const explicitRetry = payload.retry === true && payload.attemptId && payload.attemptId !== existing.attemptId && existing.response?.status === "failed";
      if (!explicitRetry) return { claimed: false, response: existing.response };
    }
    const response = {
      type: payload.type === "session:send" ? "run:status" : "request:received",
      requestId: payload.requestId,
      sessionKey: `${payload.provider}:${payload.sessionId}`,
      status: "received", at: Date.now(),
    };
    this.records.set(key, { fingerprint, attemptId: payload.attemptId ?? payload.requestId, response, expiresAt: Date.now() + RETENTION });
    await this.flush();
    return { claimed: true, response };
  }
  get(clientId, requestId) { return this.records.get(`${clientId}:${requestId}`)?.response ?? null; }
  async remember(clientId, requestId, response) {
    const key = `${clientId}:${requestId}`;
    const existing = this.records.get(key);
    if (!existing) return;
    this.records.set(key, { ...existing, response: { ...response, at: Date.now() }, expiresAt: Date.now() + RETENTION });
    await this.flush();
  }
}
