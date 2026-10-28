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
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { formatMessageTime, providerName } from "../relaydesk-meta";
import type { DeviceStatus, Message, RunSettings, SessionDetail, SessionSummary } from "../relaydesk-types";
import { ProviderIcon } from "./provider-icon";

type ConversationViewProps = {
  session: SessionSummary;
  detail: SessionDetail | null | undefined;
  messages: Message[];
  device: DeviceStatus | null;
  runningStatus?: string;
  draft: string;
  settings: RunSettings;
  modelName: string;
  managedSettings: boolean;
  sending: boolean;
  connectionError?: string;
  supportsStop?: boolean;
  messageEndRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onDraftChange: (value: string) => void;
  onFollowChange: (value: boolean) => void;
  onRetry: (requestId: string) => void;
  onOpenSettings: () => void;
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
  settings,
  modelName,
  managedSettings,
  sending,
  connectionError,
  supportsStop,
  messageEndRef,
  onBack,
  onDraftChange,
  onFollowChange,
  onRetry,
  onOpenSettings,
  onSubmit,
  onKeyDown,
  onStop,
}: ConversationViewProps) {
  const transcriptWorking = detail?.state === "working";
  const isWorking = Boolean(runningStatus) || transcriptWorking;
  const waiting = runningStatus === "waiting";
  const deliveryCopy = runningStatus === "sending"
    ? "正在发送到电脑"
    : runningStatus === "received"
      ? "电脑已收到，正在提交"
      : runningStatus === "running"
      ? "已送达，正在启动"
      : waiting
        ? `${providerName(session.provider)} 正在思考`
        : "正在继续回复";
  // Desktop conversations accept follow-up input while the active turn is running.
  const submitLocked = sending || (session.provider === "claude" && (isWorking || Boolean(detail?.terminalOpen)));
  const activity = detail?.activity ?? [];

  return (
    <section className="conversation-panel">
      <header className="conversation-header">
        <button className="back-button" type="button" onClick={onBack} aria-label="返回会话列表"><ArrowLeft size={21} /></button>
        <div className="conversation-heading">
          <strong>{session.currentWindow ? "继续上次会话" : session.title}</strong>
          <span><ProviderIcon provider={session.provider} size={15} />{providerName(session.provider)}</span>
        </div>
        {isWorking && supportsStop && !session.currentWindow ? (
          <button className="stop-button" type="button" onClick={onStop}><CircleStop size={15} /><span>停止</span></button>
        ) : (
          <span className={`connection-state ${device?.online ? "online" : ""}`}><i />{device?.online ? (isWorking ? "进行中" : "已同步") : "离线"}</span>
        )}
      </header>

      <div className="message-scroll" onScroll={(event) => {
        const element = event.currentTarget;
        onFollowChange(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
      }}>
        {connectionError ? <div className="connection-notice" role="status">{connectionError}</div> : null}
        {!detail ? (
          <div className="loading-conversation" role="status" aria-live="polite">
            <div className="loading-conversation-orbit" aria-hidden="true"><i /><i /><i /></div>
            <strong>正在打开会话</strong>
            <span className="loading-line wide" /><span className="loading-line medium" /><span className="loading-line short" />
          </div>
        ) : null}

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
            {message.delivery ? <div className={`message-delivery ${message.delivery}`}>
              <span>{({ sending: "正在发送", relayed: "已到中继，等待电脑确认", received: "电脑已收到", running: "正在提交", submitted: "已送达", uncertain: "正在核实送达状态", failed: "未能提交", retryable: "电脑尚未收到" } as Record<string, string>)[message.delivery] ?? message.delivery}</span>
              {message.error ? <small>{message.error}</small> : null}
              {message.requestId && ["uncertain", "failed", "retryable"].includes(message.delivery) ? <button type="button" onClick={() => onRetry(message.requestId!)}>{message.delivery === "uncertain" ? "查询状态" : "重新发送"}</button> : null}
            </div> : null}
          </article>
        ))}

        {isWorking ? (
          <div className="reply-pulse" role="status" aria-live="polite">
            <ProviderIcon provider={session.provider} size={18} />
            <span className="reply-pulse-dots" aria-hidden="true"><i /><i /><i /></span>
            <p>{deliveryCopy}</p>
          </div>
        ) : null}
        <div ref={messageEndRef} className="message-end" />
      </div>

      <form className="composer" onSubmit={onSubmit}>
        {session.provider === "claude" && detail?.terminalOpen ? <p className="settings-notice">这个会话正在电脑终端打开。先退出该会话再从手机继续，或在手机新建会话。</p> : null}
        <div className="composer-meta">
          <button className="run-settings-button" type="button" onClick={onOpenSettings}>
            {session.currentWindow ? <Terminal size={14} /> : <SlidersHorizontal size={14} />}
            <span>{modelName || "读取电脑设置中"}{settings.reasoning ? ` · ${settings.reasoning}` : ""}{managedSettings ? " · 手机设置" : ""}</span>
          </button>
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
          <textarea rows={1} maxLength={12_000} value={draft} onChange={(event) => {
            onDraftChange(event.target.value);
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${Math.min(150, event.currentTarget.scrollHeight)}px`;
          }} onKeyDown={onKeyDown} placeholder={isWorking ? "继续补充，电脑会接收后续消息" : `给 ${providerName(session.provider)} 发消息`} />
          <button type="submit" disabled={!draft.trim() || submitLocked} aria-label="发送"><ArrowUp size={20} /></button>
        </div>
      </form>
    </section>
  );
}

export function EmptyConversation({ provider }: { provider: SessionSummary["provider"] }) {
  return (
    <section className="conversation-panel empty">
      <div className="conversation-empty"><ProviderIcon provider={provider} size={40} /><h2>{providerName(provider)}</h2><p>选择一个会话继续。</p></div>
    </section>
  );
}
