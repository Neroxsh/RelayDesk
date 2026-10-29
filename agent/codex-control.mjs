import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// Desktop client coordination is versioned separately from app-server JSON-RPC.
// Never start another app-server for a conversation owned by the desktop.
const versions = {
  initialize: 0, "thread-owner-discovery": 1,
  "thread-follower-command-approval-decision": 1, "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1, "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-update-thread-settings": 2, "thread-follower-interrupt-turn": 4,
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const blockedKeys = new Set(["__proto__", "prototype", "constructor"]);
export function applyDesktopPatches(state, patches) {
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some((key) => blockedKeys.has(String(key)))) throw new Error("无效桌面状态补丁");
    if (!patch.path.length) { if (patch.op === "replace") state = patch.value; else throw new Error("无效根补丁"); continue; }
    let parent = state;
    for (const key of patch.path.slice(0, -1)) { parent = parent?.[key]; if (!parent || typeof parent !== "object") throw new Error("桌面状态需重新同步"); }
    const key = patch.path.at(-1);
    if (patch.op === "remove") { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (patch.op === "add" && Array.isArray(parent)) parent.splice(Number(key), 0, patch.value);
    else if (["add", "replace"].includes(patch.op)) parent[key] = patch.value;
    else throw new Error("未知桌面状态补丁");
  }
  return state;
}

export function codexPendingRequests(state) {
  return (state?.requests ?? []).flatMap((request) => {
    const p = request.params ?? {}, base = { id: String(request.id), provider: "codex" };
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
      const available = p.availableDecisions;
      const choices = [["allow", "accept"], ["session", "acceptForSession"], ["deny", "decline"]].filter(([, value]) => !available || available.includes(value)).map(([key]) => key);
      return [{ ...base, kind: "approval", title: request.method.includes("commandExecution") ? "允许执行命令？" : "允许修改文件？", description: [p.reason, p.command, p.cwd].filter(Boolean).join("\n").slice(0, 16000), choices, tool: request.method }];
    }
    if (request.method === "item/permissions/requestApproval") return [{ ...base, kind: "approval", title: "允许扩展权限？", description: `${p.reason ?? ""}\n${JSON.stringify(p.permissions, null, 2)}`.slice(0, 16000), choices: ["allow", "deny"], tool: request.method }];
    if (request.method === "item/tool/requestUserInput") return (p.questions ?? []).some((q) => q.isSecret) ? [{ ...base, kind: "notice", title: "请在电脑填写敏感信息", choices: [] }] : [{ ...base, kind: "question", title: "需要你选择", questions: (p.questions ?? []).map((q) => ({ ...q, multiSelect: false })), choices: ["answer"], tool: request.method }];
    if (request.method === "mcpServer/elicitation/request") {
      if (p.mode !== "form" || Object.keys(p.requestedSchema?.properties ?? {}).length) return [{ ...base, kind: "notice", title: "需要在电脑处理", description: p.message || "这个确认包含登录、外部网页或复杂表单，请在电脑完成。", choices: [], tool: request.method }];
      return [{ ...base, kind: "approval", title: "允许这项操作？", description: String(p.message ?? "").slice(0, 16000), choices: ["allow", "deny"], tool: request.method }];
    }
    return [];
  });
}

export class CodexControl extends EventEmitter {
  constructor({ pipePath, timeoutMs = 6000 } = {}) {
    super(); this.pipePath = pipePath || process.env.RELAYDESK_CODEX_IPC || (process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock"));
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.states = new Map(); this.watched = new Map(); this.consumedPlans = new Map(); this.clientId = "initializing-client";
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.socket = net.createConnection(this.pipePath); this.buffer = Buffer.alloc(0);
      this.socket.on("data", (chunk) => { try { this.consume(chunk); } catch { this.socket.destroy(); } });
      this.socket.on("error", () => undefined);
      this.socket.once("close", () => { this.connecting = null; this.clientId = "initializing-client"; this.states.clear(); this.watched.clear(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex 桌面连接中断，请刷新后查看结果")); } this.pending.clear(); });
      await new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); });
      const result = await this.request("initialize", { clientType: "relaydesk" });
      if (typeof result.clientId !== "string") throw new Error("不支持的 Codex 桌面连接版本");
      this.clientId = result.clientId;
    })();
    try { await this.connecting; } catch (error) { this.socket?.destroy(); this.connecting = null; throw error; }
  }
  send(message) { const bytes = Buffer.from(JSON.stringify(message)); const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); this.socket.write(frame); }
  request(method, params, targetClientId) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Codex 桌面未确认操作，请刷新查看，不要重复点击")); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "request", requestId, sourceClientId: this.clientId, version: versions[method], method, params, ...(targetClientId ? { targetClientId } : {}), timeoutMs: this.timeoutMs });
    });
  }
  broadcast(method, params, version = 1, targetClientIds) { this.send({ type: "broadcast", method, version, params, sourceClientId: this.clientId, ...(targetClientIds ? { targetClientIds } : {}) }); }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0); if (!length || length > 64 * 1024 * 1024) throw new Error("桌面响应过大");
      if (this.buffer.length < length + 4) break;
      const message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); this.buffer = this.buffer.subarray(length + 4); this.handle(message);
    }
  }
  handle(message) {
    if (message.type === "response") {
      const p = this.pending.get(message.requestId); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.requestId);
      if (message.resultType === "error") p.reject(Object.assign(new Error(`Codex 桌面接口：${message.error}`), { code: "DESKTOP_CONTROL_ERROR" }));
      else p.resolve({ ...message.result, ownerClientId: message.handledByClientId });
      return;
    }
    if (message.type === "client-discovery-request") { this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); return; }
    if (message.type === "request") { this.send({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" }); return; }
    if (message.type !== "broadcast" || (message.targetClientIds && !message.targetClientIds.includes(this.clientId))) return;
    const p = message.params;
    if (message.method === "client-status-changed" && p?.status === "disconnected") {
      for (const [id, owner] of this.watched) if (owner === p.clientId) { this.watched.delete(id); this.states.delete(id); }
    }
    if (message.method === "thread-stream-state-changed" && message.version === 11 && p?.hostId === "local" && this.watched.get(p.conversationId) === message.sourceClientId) {
      const change = p.change, previous = this.states.get(p.conversationId);
      if (change.type === "snapshot") this.states.set(p.conversationId, { state: change.conversationState, revision: change.revision, owner: message.sourceClientId });
      else if (change.type === "patches" && previous?.revision === change.baseRevision) {
        try { previous.state = applyDesktopPatches(previous.state, change.patches); previous.revision = change.revision; } catch { this.states.delete(p.conversationId); this.resync(p.conversationId); }
      } else { this.states.delete(p.conversationId); this.resync(p.conversationId); }
      this.emit("changed", p.conversationId);
    }
  }
  resync(id) { this.broadcast("thread-stream-following-changed", { conversationId: id, hostId: "local", following: false }); this.broadcast("thread-stream-following-changed", { conversationId: id, hostId: "local", following: true }); }
  async watch(id) {
    if (!uuid.test(id)) throw new Error("会话 ID 无效");
    await this.connect();
    if (!this.watched.has(id)) {
      const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: id });
      this.watched.set(id, owner.ownerClientId);
      this.broadcast("thread-stream-following-changed", { hostId: "local", conversationId: id, following: true }, 1, [owner.ownerClientId]);
      if (this.watched.size > 12) { const oldest = this.watched.keys().next().value; this.broadcast("thread-stream-following-changed", { hostId: "local", conversationId: oldest, following: false }); this.watched.delete(oldest); this.states.delete(oldest); }
    }
    return this.states.get(id);
  }
  async snapshot(id) {
    await this.watch(id);
    if (!this.states.has(id)) await new Promise((resolve) => { const done = () => { clearTimeout(timer); this.off("changed", listener); resolve(); }; const listener = (changed) => { if (changed === id) done(); }; const timer = setTimeout(done, 1200); this.on("changed", listener); });
    const state = this.states.get(id)?.state;
    if (!state) return { available: false, reason: "当前 Codex 桌面未提供会话控制状态，请在电脑打开该会话" };
    const t = state.latestThreadSettings ?? {}, sandbox = t.sandboxPolicy ?? state.currentPermissions?.sandboxPolicy;
    const turns = state.turnHistory?.kind === "canonical" ? Object.values(state.turnHistory.history?.entitiesByKey ?? {}) : state.turns ?? [];
    const latest = turns.toSorted((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0)).at(-1), pending = codexPendingRequests(state);
    const working = turns.some((turn) => turn.status === "inProgress") || state.threadRuntimeStatus?.type === "active" || pending.length > 0;
    const planReady = !working && (t.collaborationMode ?? state.latestCollaborationMode)?.mode === "plan" && latest?.status === "completed" && !pending.length && this.consumedPlans.get(id) !== latest.turnId;
    return { available: true, canSend: true, canStop: true, canSetPermissions: true, pending, working, planReady, planId: planReady ? latest.turnId : undefined, settings: { model: t.model ?? state.latestModel ?? "", reasoning: t.effort ?? state.latestReasoningEffort ?? "", permission: sandbox?.type === "dangerFullAccess" ? "full" : sandbox?.type === "readOnly" ? "read-only" : "workspace", serviceTier: t.serviceTier ?? "", source: "desktop-live" } };
  }
  async respond(id, interactionId, decision, answers) {
    await this.watch(id);
    const request = this.states.get(id)?.state?.requests?.find((r) => String(r.id) === interactionId);
    if (!request) throw new Error("这个确认已在电脑处理或已过期，请刷新");
    const offered = codexPendingRequests({ requests: [request] })[0];
    if (!offered?.choices.includes(decision)) throw new Error("此确认不支持这个选项，请刷新");
    const p = request.params, args = { conversationId: id, requestId: request.id };
    let method;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
      if (!["allow", "session", "deny"].includes(decision)) throw new Error("确认选项无效");
      args.decision = decision === "allow" ? "accept" : decision === "session" ? "acceptForSession" : "decline";
      method = request.method.includes("commandExecution") ? "thread-follower-command-approval-decision" : "thread-follower-file-approval-decision";
    } else if (request.method === "item/permissions/requestApproval") {
      if (!["allow", "deny"].includes(decision)) throw new Error("确认选项无效");
      method = "thread-follower-permissions-request-approval-response"; args.response = { permissions: decision === "allow" ? p.permissions : {}, scope: "turn" };
    } else if (request.method === "item/tool/requestUserInput") {
      method = "thread-follower-submit-user-input"; const result = {};
      for (const q of p.questions ?? []) { const answer = answers?.[q.id]; if (!Array.isArray(answer) || !answer.length || answer.some((a) => typeof a !== "string" || a.length > 12000)) throw new Error("请回答所有问题"); result[q.id] = { answers: answer }; }
      args.response = { answers: result };
    } else if (request.method === "mcpServer/elicitation/request" && p.mode === "form" && !Object.keys(p.requestedSchema?.properties ?? {}).length) {
      if (!["allow", "deny"].includes(decision)) throw new Error("确认选项无效");
      method = "thread-follower-submit-mcp-server-elicitation-response"; args.response = { action: decision === "allow" ? "accept" : "decline", content: decision === "allow" ? {} : null };
    } else throw new Error("此确认需在电脑处理");
    return this.request(method, args, this.watched.get(id));
  }
  async stop(id) {
    await this.watch(id); const state = this.states.get(id)?.state;
    const turns = state?.turnHistory?.kind === "canonical" ? Object.values(state.turnHistory.history?.entitiesByKey ?? {}) : state?.turns ?? [];
    const turnId = turns.findLast((t) => t.status === "inProgress")?.turnId ?? state?.activeTurnId;
    if (!turnId) throw new Error("会话没有可停止的任务，请刷新");
    return this.request("thread-follower-interrupt-turn", { conversationId: id, mode: "user-stop", expectedTurnId: turnId }, this.watched.get(id));
  }
  async setPermission(id, permission) {
    await this.watch(id);
    if (!["read-only", "workspace", "full"].includes(permission)) throw new Error("权限选项无效");
    const sandboxPolicy = permission === "full" ? { type: "dangerFullAccess" } : permission === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    const result = await this.request("thread-follower-update-thread-settings", { conversationId: id, threadSettings: { sandboxPolicy, approvalPolicy: permission === "full" ? "never" : "on-request", approvalsReviewer: "user", permissions: null } }, this.watched.get(id));
    if (result.applied !== true) throw new Error("电脑未应用权限设置，请刷新");
    return result;
  }
  async acceptPlan(id, planId) {
    const control = await this.snapshot(id);
    if (!control.planReady || !planId || control.planId !== planId) throw new Error("计划状态已变化，请刷新会话后确认");
    const state = this.states.get(id).state;
    const previous = state.latestThreadSettings?.collaborationMode ?? state.latestCollaborationMode;
    // Reserve before dispatch. A delayed acknowledgement must never cause a
    // second execution from another phone or an automatic retry.
    if (this.consumedPlans.get(id) === planId) throw new Error("计划执行已提交，请查看当前会话");
    this.consumedPlans.set(id, planId);
    const result = await this.request("thread-follower-update-thread-settings", { conversationId: id, threadSettings: { collaborationMode: { ...previous, mode: "default" } } }, this.watched.get(id));
    if (result.applied !== true) throw new Error("电脑未确认退出计划模式，请刷新");
    return result;
  }
  close() { this.socket?.destroy(); }
}
export const codexControl = new CodexControl();
