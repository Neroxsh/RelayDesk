"use client";

import { useState } from "react";
import { ShieldCheck, MessageCircleQuestion, LoaderCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { InteractionRequest } from "../relaydesk-types";

export type InteractionAnswer = { decision: string; answers?: Record<string, string[]>; permission?: string };
export function InteractionCard({ request, busy, onRespond }: { request: InteractionRequest; busy: boolean; onRespond: (value: InteractionAnswer) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [planPermission, setPlanPermission] = useState("ask");
  const questions = request.questions ?? [];
  const values = Object.fromEntries(questions.map((q) => [q.id, custom[q.id]?.trim() ? [custom[q.id].trim()] : answers[q.id] ?? []]));
  return <section className="interaction-card" role="region" aria-label={request.title}>
    <header>{request.kind === "question" ? <MessageCircleQuestion size={19} /> : <ShieldCheck size={19} />}<strong>{request.title}</strong><span>等待你处理</span></header>
    {request.description && request.kind !== "question" ? <div className="interaction-description"><ReactMarkdown>{request.description}</ReactMarkdown></div> : null}
    {questions.map((q) => <fieldset key={q.id} disabled={busy}><legend>{q.header ? `${q.header} · ` : ""}{q.question}</legend>
      <div className="interaction-options">{q.options?.map((option) => <button key={option.label} type="button" aria-pressed={answers[q.id]?.includes(option.label) && !custom[q.id]?.trim()} className={answers[q.id]?.includes(option.label) && !custom[q.id]?.trim() ? "selected" : ""} onClick={() => {
        setCustom((v) => ({ ...v, [q.id]: "" }));
        setAnswers((v) => ({ ...v, [q.id]: q.multiSelect ? v[q.id]?.includes(option.label) ? v[q.id].filter((s) => s !== option.label) : [...(v[q.id] ?? []), option.label] : [option.label] }));
      }}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div>
      <textarea value={custom[q.id] ?? ""} maxLength={12000} placeholder="或输入自己的回答" onChange={(event) => setCustom((v) => ({ ...v, [q.id]: event.target.value }))} />
    </fieldset>)}
    {request.tool === "ExitPlanMode" ? <label className="plan-permission">执行权限<select value={planPermission} disabled={busy} onChange={(event) => setPlanPermission(event.target.value)}><option value="ask">逐次询问</option><option value="workspace">允许编辑，命令逐次确认</option><option value="full">完全访问</option></select></label> : null}
    <footer>{busy ? <span role="status"><LoaderCircle className="spin" size={15} />正在向电脑提交…</span> : null}
      {request.choices.includes("deny") ? <button disabled={busy} type="button" onClick={() => onRespond({ decision: "deny" })}>拒绝</button> : null}
      {request.choices.includes("session") ? <button disabled={busy} type="button" onClick={() => onRespond({ decision: "session" })}>本会话允许</button> : null}
      {request.choices.includes("allow") ? <button disabled={busy} className="primary" type="button" onClick={() => {
        if (request.tool === "ExitPlanMode" && planPermission === "full" && !window.confirm("允许 Claude 完全访问本机文件并执行命令，继续？")) return;
        onRespond({ decision: "allow", ...(request.tool === "ExitPlanMode" ? { permission: planPermission } : {}) });
      }}>{request.tool === "ExitPlanMode" ? "批准并执行" : "允许这一次"}</button> : null}
      {request.choices.includes("answer") ? <button disabled={busy || questions.some((q) => !values[q.id]?.length)} className="primary" type="button" onClick={() => onRespond({ decision: "answer", answers: values })}>提交回答</button> : null}
    </footer>
  </section>;
}
