import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export function publicInteraction(id, sessionId, tool, input, source = "claude") {
  const questions = tool === "AskUserQuestion" ? (input.questions ?? []).map((q, index) => ({ id: q.question || String(index), question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect), options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })) })) : undefined;
  let description = input.plan ?? [...new Set([input.description, input.command, input.file_path, input.url].filter((value) => typeof value === "string" && value))].join("\n");
  if (tool === "Edit") description += `\n\n修改前：\n\`\`\`\n${String(input.old_string ?? "").slice(0, 10000)}\n\`\`\`\n修改后：\n\`\`\`\n${String(input.new_string ?? "").slice(0, 10000)}\n\`\`\``;
  if (tool === "Write" && typeof input.content === "string") description += `\n\n写入内容：\n\`\`\`\n${input.content.slice(0, 16000)}\n\`\`\``;
  return { id, provider: source, sessionId, kind: questions ? "question" : "approval", tool,
    title: questions ? "Claude 需要你选择" : tool === "ExitPlanMode" ? "计划已完成，是否执行？" : `允许 Claude 使用 ${tool}？`,
    description: String(description || JSON.stringify(input, null, 2)).slice(0, 24000),
    questions, choices: questions ? ["answer", "deny"] : tool === "ExitPlanMode" ? ["allow", "deny"] : ["allow", "deny"], createdAt: Date.now() };
}

export function claudeDecision(pending, decision, answers, permission) {
  if (!["allow", "deny", "answer"].includes(decision)) throw new Error("确认选项无效");
  if (decision === "deny") return { behavior: "deny", message: "用户在 RelayDesk 手机端拒绝了这项操作。" };
  const updatedInput = { ...pending.input };
  if (pending.tool === "AskUserQuestion") {
    updatedInput.answers = {};
    for (const q of pending.input.questions ?? []) {
      const values = answers?.[q.question];
      if (!Array.isArray(values) || !values.length || (!q.multiSelect && values.length !== 1) || values.some((v) => typeof v !== "string" || !v.trim() || v.length > 12000)) throw new Error("请回答所有问题");
      updatedInput.answers[q.question] = values.join(", ");
    }
  }
  const result = { behavior: "allow", updatedInput };
  if (pending.tool === "ExitPlanMode") {
    const mode = permission === "full" ? "bypassPermissions" : permission === "ask" ? "default" : "acceptEdits";
    // ExitPlanMode's hook input is different from the SDK callback's result.
    updatedInput.plan = pending.input.plan;
    result.updatedPermissions = [{ type: "setMode", mode, destination: "session" }];
  }
  return result;
}

export class InteractionBroker extends EventEmitter {
  constructor() { super(); this.pending = new Map(); }
  list(sessionId) { return [...this.pending.values()].filter((p) => p.sessionId === sessionId).map((p) => p.public); }
  ask({ sessionId, tool, input, id = randomUUID(), timeoutMs = 9 * 60_000, fallback = null }) {
    if (this.pending.has(id)) throw new Error("确认请求 ID 重复");
    const publicRequest = publicInteraction(id, sessionId, tool, input);
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, fallback), timeoutMs); timer.unref?.();
      this.pending.set(id, { id, sessionId, tool, input, public: publicRequest, resolve, timer });
    });
    this.emit("changed", sessionId); return promise;
  }
  respond(sessionId, id, decision, answers, permission) {
    const p = this.pending.get(id);
    if (!p || p.sessionId !== sessionId) throw new Error("这个确认已处理或已过期，请刷新");
    if (!p.public.choices.includes(decision)) throw new Error("当前确认不支持这个选项");
    const result = claudeDecision(p, decision, answers, permission);
    this.finish(id, result); return { ok: true };
  }
  finish(id, result) { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.pending.delete(id); p.resolve(result); this.emit("resolved", { sessionId: p.sessionId, decision: result }); this.emit("changed", p.sessionId); }
  cancelSession(sessionId) { for (const p of this.pending.values()) if (p.sessionId === sessionId) this.finish(p.id, null); }
}
export const interactions = new InteractionBroker();
