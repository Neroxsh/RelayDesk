"use client";

import type { FormEvent, KeyboardEvent, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import { formatMessageTime, PROVIDERS, providerName } from "../relaydesk-meta";
import type { DeviceStatus, Message, PermissionMode, SessionDetail, SessionSummary } from "../relaydesk-types";

type ConversationViewProps = {
  session: SessionSummary;
  detail: SessionDetail | null | undefined;
  messages: Message[];
  device: DeviceStatus | null;
  runningStatus?: string;
  draft: string;
  mode: PermissionMode;
  sending: boolean;
  messageEndRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: PermissionMode) => void;
  onSubmit: (event?: FormEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
};

export function ConversationView({
  session,
  detail,
  messages,
  device,
  runningStatus,
  draft,
  mode,
  sending,
  messageEndRef,
  onBack,
  onDraftChange,
  onModeChange,
  onSubmit,
  onKeyDown,
  onStop,
}: ConversationViewProps) {
  const transcriptWorking = detail?.state === "working";
  const isWorking = Boolean(runningStatus) || transcriptWorking;
  const waiting = runningStatus === "waiting";
  const deliveryCopy = runningStatus === "sending"
    ? "正在发送到电脑"
    : runningStatus === "running"
      ? "已送达，正在启动"
      : waiting
        ? `${providerName(session.provider)} 正在思考`
        : "正在继续回复";
  // The current Codex window accepts a queued instruction while its existing task is
  // running. Historical CLI sessions still need to finish before another run starts.
  const submitLocked = sending || Boolean(runningStatus) || (!session.currentWindow && transcriptWorking);
  const activity = detail?.activity ?? [];

  return (
    <section className="conversation-panel">
      <header className="conversation-header">
        <button className="back-button" type="button" onClick={onBack} aria-label="返回会话列表"><ArrowLeft size={21} /></button>
        <div className="conversation-heading">
          <strong>{session.currentWindow ? "电脑上的当前任务" : session.title}</strong>
          <span><i className={`provider-dot ${session.provider}`} />{providerName(session.provider)}</span>
        </div>
        {isWorking && !session.currentWindow ? (
          <button className="stop-button" type="button" onClick={onStop}><CircleStop size={15} /><span>停止</span></button>
        ) : (
          <span className={`connection-state ${device?.online ? "online" : ""}`}><i />{device?.online ? (isWorking ? "进行中" : "已同步") : "离线"}</span>
        )}
      </header>

      <div className="message-scroll">
        {!detail ? <div className="loading-conversation"><span /><span /><span /></div> : null}

        {activity.length ? (
          <details className={`activity-card ${isWorking ? "working" : ""}`} open={isWorking || undefined}>
            <summary>
              {isWorking ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              <span><strong>{isWorking ? "任务进行中" : "最近活动"}</strong><small>{activity.at(-1)?.label}</small></span>
              <ChevronDown size={16} />
            </summary>
            <ol>{activity.slice(-8).map((item) => (
              <li key={item.id} className={item.status}><i /> <span>{item.label}</span>{item.detail ? <small>{item.detail}</small> : null}</li>
            ))}</ol>
          </details>
        ) : null}

        {messages.map((message) => message.role === "tool" ? (
          <details className="tool-message" key={message.id}><summary><Terminal size={15} />运行记录</summary><div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div></details>
        ) : (
          <article className={`message ${message.role} ${message.pending ? "pending" : ""}`} key={message.id}>
            <div className="message-label"><b>{message.role === "user" ? "你" : providerName(session.provider)}</b>{formatMessageTime(message.timestamp) ? <time>{formatMessageTime(message.timestamp)}</time> : null}</div>
            <div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
          </article>
        ))}

        {isWorking ? (
          <div className="reply-pulse" role="status" aria-live="polite">
            <span className={`provider-dot ${session.provider}`} />
            <span className="reply-pulse-dots" aria-hidden="true"><i /><i /><i /></span>
            <p>{deliveryCopy}</p>
          </div>
        ) : null}
        <div ref={messageEndRef} className="message-end" />
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <div className="composer-meta">
          {session.currentWindow ? (
            <span className="target-label"><Terminal size={14} />电脑当前窗口</span>
          ) : (
            <div className="mode-switch" aria-label="执行权限">
              <button type="button" className={mode === "safe" ? "active" : ""} onClick={() => onModeChange("safe")}><ShieldCheck size={14} />需确认</button>
              <button type="button" className={mode === "full" ? "active warning" : ""} onClick={() => onModeChange("full")}><Zap size={14} />自动执行</button>
            </div>
          )}
          <span className="sync-copy">{
            session.currentWindow && runningStatus
              ? "正在送达电脑"
              : session.currentWindow && transcriptWorking
                ? "发送后会排到当前任务后"
                : isWorking
                  ? "回复会持续显示在这里"
                  : "与电脑保持同步"
          }</span>
        </div>
        <div className="composer-input">
          <textarea rows={1} value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={onKeyDown} placeholder={waiting ? "正在等待回复" : `给 ${providerName(session.provider)} 发消息`} />
          <button type="submit" disabled={!draft.trim() || submitLocked} aria-label="发送"><ArrowUp size={20} /></button>
        </div>
      </form>
    </section>
  );
}

export function EmptyConversation({ provider }: { provider: SessionSummary["provider"] }) {
  return (
    <section className="conversation-panel empty">
      <div className="conversation-empty"><span className={`provider-dot ${provider}`} /><h2>{PROVIDERS[provider].name}</h2><p>选择一个会话继续。</p></div>
    </section>
  );
}
