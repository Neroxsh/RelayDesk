"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createPhoneKeys,
  decryptJson,
  deriveSessionKey,
  encryptJson,
  exportSessionKey,
  importSessionKey,
  requestId,
  sha256,
} from "./remote-crypto";

type Provider = "codex" | "claude";
type SessionSummary = {
  id: string;
  key: string;
  provider: Provider;
  title: string;
  cwd: string;
  projectName?: string;
  projectPath?: string;
  updatedAt: number;
  recent?: boolean;
  active?: boolean;
  currentWindow?: boolean;
  openInCodex?: boolean;
};
type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string | null;
};
type SessionDetail = SessionSummary & { messages: Message[] };
type StoredPairing = {
  clientId: string;
  clientToken: string;
  key: string;
  device: { id: string; name: string; platform: string };
};
type PendingPair = {
  requestId: string;
  pollToken: string;
  privateKey: JsonWebKey;
  pairKeyHash: string;
  deviceName: string;
  expiresAt: number;
};
type DeviceStatus = { name: string; platform: string; online: boolean; lastSeenAt: number };
type RemotePayload = Record<string, unknown> & { type?: string; requestId?: string };
type PollResponse = {
  error?: string;
  cursor?: number;
  device?: DeviceStatus | null;
  messages?: Array<{ id: number; kind: string; envelope: string }>;
};

const STORAGE_KEY = "relaydesk.pairing.v2";
const LEGACY_STORAGE_KEY = "relaydesk.pairing.v1";
const PENDING_KEY = "relaydesk.pending.v2";

function normalizePairKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 16);
}

function formatPairKey(value: string) {
  return normalizePairKey(value).match(/.{1,4}/g)?.join("-") ?? "";
}

function formatWhen(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatMessageTime(timestamp?: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function phoneName() {
  const value = navigator.userAgent;
  if (/iPhone/i.test(value)) return "iPhone";
  if (/iPad/i.test(value)) return "iPad";
  if (/Android/i.test(value)) return "Android 手机";
  return "手机浏览器";
}

function PairScreen({ onPaired }: { onPaired: (pairing: StoredPairing) => void }) {
  const [keyText, setKeyText] = useState("");
  const [pending, setPending] = useState<PendingPair | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as PendingPair;
        if (saved.expiresAt > Date.now()) setPending(saved);
        else localStorage.removeItem(PENDING_KEY);
      } catch {
        localStorage.removeItem(PENDING_KEY);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch(`/api/pair/status?requestId=${encodeURIComponent(pending.requestId)}`, {
          headers: { authorization: `Bearer ${pending.pollToken}` },
          cache: "no-store",
        });
        const data = await response.json() as {
          status?: string;
          error?: string;
          clientId?: string;
          clientToken?: string;
          device?: { id: string; name: string; platform: string; publicKey: JsonWebKey };
        };
        if (!response.ok) throw new Error(data.error ?? "无法查询确认状态");
        if (data.status === "approved" && data.clientId && data.clientToken && data.device) {
          const sessionKey = await deriveSessionKey(pending.privateKey, data.device.publicKey, pending.pairKeyHash);
          const pairing: StoredPairing = {
            clientId: data.clientId,
            clientToken: data.clientToken,
            key: await exportSessionKey(sessionKey),
            device: { id: data.device.id, name: data.device.name, platform: data.device.platform },
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
          localStorage.removeItem(PENDING_KEY);
          if (!stopped) onPaired(pairing);
          return;
        }
        if (["rejected", "expired"].includes(data.status ?? "")) {
          localStorage.removeItem(PENDING_KEY);
          if (!stopped) {
            setPending(null);
            setError(data.status === "rejected" ? "电脑端拒绝了这次绑定" : "确认请求已过期，请重新提交");
          }
          return;
        }
      } catch (pollError) {
        if (!stopped) setError(pollError instanceof Error ? pollError.message : "连接暂时中断");
      }
      if (!stopped) timer = setTimeout(check, 1400);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pending, onPaired]);

  async function requestPair(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePairKey(keyText);
    if (normalized.length !== 16 || working) return;
    setWorking(true);
    setError("");
    try {
      const pairKeyHash = await sha256(normalized);
      const keys = await createPhoneKeys();
      const response = await fetch("/api/pair/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairKeyHash, publicKey: keys.publicKey, phoneName: phoneName() }),
      });
      const data = await response.json() as {
        error?: string;
        requestId?: string;
        pollToken?: string;
        deviceName?: string;
        expiresAt?: number;
      };
      if (!response.ok || !data.requestId || !data.pollToken || !data.expiresAt) {
        throw new Error(data.error ?? "无法提交连接请求");
      }
      const next: PendingPair = {
        requestId: data.requestId,
        pollToken: data.pollToken,
        privateKey: keys.privateKey,
        pairKeyHash,
        deviceName: data.deviceName ?? "你的电脑",
        expiresAt: data.expiresAt,
      };
      localStorage.setItem(PENDING_KEY, JSON.stringify(next));
      setPending(next);
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "连接失败，请重试");
    } finally {
      setWorking(false);
    }
  }

  function cancelPending() {
    localStorage.removeItem(PENDING_KEY);
    setPending(null);
    setError("");
  }

  return (
    <main className="pair-shell">
      <section className="pair-card" aria-labelledby="pair-title">
        <div className="brand-mark" aria-hidden="true"><span>R</span></div>
        <p className="eyebrow">RelayDesk · 私人远程工作台</p>
        {pending ? (
          <div className="approval-state">
            <div className="approval-icon"><span /></div>
            <h1 id="pair-title">请在电脑上确认</h1>
            <p>已向 <strong>{pending.deviceName}</strong> 发送永久绑定请求。电脑控制中心会自动打开。</p>
            <div className="approval-steps"><span>1</span><b>找到“等待确认”</b><i /><span>2</span><b>点击“确认绑定”</b></div>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="text-button" type="button" onClick={cancelPending}>取消并重新输入</button>
          </div>
        ) : (
          <>
            <h1 id="pair-title">把电脑上的 Codex，装进口袋。</h1>
            <p className="pair-lead">输入电脑控制中心显示的永久连接密钥。只需一次，确认后不再登录、不再重复认证。</p>
            <form onSubmit={requestPair} className="pair-form">
              <label htmlFor="pair-key">永久连接密钥</label>
              <input
                id="pair-key"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoFocus
                maxLength={19}
                value={keyText}
                onChange={(event) => setKeyText(formatPairKey(event.target.value))}
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
              {error ? <p className="form-error">{error}</p> : null}
              <button type="submit" disabled={normalizePairKey(keyText).length !== 16 || working}>
                {working ? "正在联系电脑…" : "请求连接这台电脑"}
              </button>
            </form>
            <div className="security-note"><span>●</span><div><strong>电脑确认后永久绑定</strong><p>中继只看到密文；连接密钥明文只保存在你的电脑和输入它的手机上。</p></div></div>
          </>
        )}
      </section>
      <p className="pair-foot">无需 ChatGPT 账号 · 无需开放电脑公网端口</p>
    </main>
  );
}

export default function Home() {
  const [pairing, setPairing] = useState<StoredPairing | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"safe" | "full">("safe");
  const [running, setRunning] = useState<Record<string, string>>({});
  const [liveMessages, setLiveMessages] = useState<Record<string, Message[]>>({});
  const [toast, setToast] = useState("");
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const cursorRef = useRef(0);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<StoredPairing | null>(null);
  const optimisticRef = useRef(new Map<string, { sessionKey: string; messageId: string }>());
  const waitingForReplyRef = useRef(new Map<string, string | null>());
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        try { setPairing(JSON.parse(raw) as StoredPairing); }
        catch { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_STORAGE_KEY); }
      }
      setHydrated(true);
    }, 0);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    pairingRef.current = pairing;
    keyRef.current = null;
    cursorRef.current = 0;
  }, [pairing]);

  const remoteSend = useCallback(async (payload: RemotePayload) => {
    const current = pairingRef.current;
    if (!current) throw new Error("手机尚未绑定");
    if (!keyRef.current) keyRef.current = await importSessionKey(current.key);
    const envelope = await encryptJson(keyRef.current, payload);
    const response = await fetch("/api/client/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${current.clientToken}` },
      body: JSON.stringify({ envelope }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? "发送失败");
  }, []);

  const handlePayload = useCallback((payload: RemotePayload) => {
    const rollbackOptimistic = (remoteRequestId: string | undefined) => {
      if (!remoteRequestId) return;
      const optimistic = optimisticRef.current.get(remoteRequestId);
      if (!optimistic) return;
      setLiveMessages((value) => ({
        ...value,
        [optimistic.sessionKey]: (value[optimistic.sessionKey] ?? []).filter((message) => message.id !== optimistic.messageId),
      }));
      optimisticRef.current.delete(remoteRequestId);
    };
    if (payload.type === "sessions:snapshot" && Array.isArray(payload.sessions)) {
      setSessions(payload.sessions as SessionSummary[]);
      return;
    }
    if (payload.type === "session:snapshot" && payload.session) {
      const session = payload.session as SessionDetail;
      setDetails((value) => ({ ...value, [session.key]: session }));
      setLiveMessages((value) => ({ ...value, [session.key]: [] }));
      if (waitingForReplyRef.current.has(session.key)) {
        const baseline = waitingForReplyRef.current.get(session.key);
        const latestAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        if (latestAssistant && latestAssistant.id !== baseline) {
          waitingForReplyRef.current.delete(session.key);
          setRunning((value) => {
            const next = { ...value };
            delete next[session.key];
            return next;
          });
          setToast("Codex 已回复 · 内容已自动同步");
        }
      }
      return;
    }
    if (payload.type === "run:event" && payload.sessionKey && payload.event) {
      const event = payload.event as { type?: string; text?: string };
      const role = event.type === "assistant" ? "assistant" : "tool";
      const message: Message = { id: `${Date.now()}-${Math.random()}`, role, content: event.text ?? "" };
      setLiveMessages((value) => ({
        ...value,
        [payload.sessionKey as string]: [...(value[payload.sessionKey as string] ?? []), message],
      }));
      return;
    }
    if (payload.type === "run:status" && payload.sessionKey) {
      const key = payload.sessionKey as string;
      const status = String(payload.status ?? "");
      setRunning((value) => {
        const next = { ...value };
        if (["completed", "failed"].includes(status)) delete next[key];
        else next[key] = status === "submitted" ? "waiting" : status;
        return next;
      });
      if (status === "failed") {
        waitingForReplyRef.current.delete(key);
        rollbackOptimistic(payload.requestId);
        setToast(String(payload.error ?? "电脑端执行失败"));
      } else if (["completed", "submitted"].includes(status) && payload.requestId) {
        optimisticRef.current.delete(payload.requestId);
      }
      if (status === "completed") waitingForReplyRef.current.delete(key);
      if (status === "submitted") setToast("已送达电脑 · 等待 Codex 回复");
      return;
    }
    if (payload.type === "request:error") {
      rollbackOptimistic(payload.requestId);
      setToast(String(payload.error ?? "请求失败"));
      setRunning({});
    }
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/client/poll?after=${cursorRef.current}`, {
          headers: { authorization: `Bearer ${pairing.clientToken}` },
          cache: "no-store",
        });
        const data = await response.json() as PollResponse;
        if (response.status === 401) {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          if (!stopped) { setPairing(null); setToast("这台手机的绑定已解除"); }
          return;
        }
        if (!response.ok) throw new Error(data.error ?? "同步失败");
        if (!stopped && data.device) setDevice(data.device);
        if (!keyRef.current) keyRef.current = await importSessionKey(pairing.key);
        for (const message of data.messages ?? []) {
          cursorRef.current = Math.max(cursorRef.current, Number(message.id) || 0);
          if (message.kind !== "encrypted") continue;
          const payload = await decryptJson(keyRef.current, JSON.parse(message.envelope)) as RemotePayload;
          if (!stopped) handlePayload(payload);
        }
        if (!stopped) timer = setTimeout(poll, 1100);
      } catch (error) {
        if (!stopped) {
          setToast(error instanceof Error ? error.message : "连接暂时中断");
          timer = setTimeout(poll, 3000);
        }
      }
    };
    void remoteSend({ type: "sessions:list", requestId: requestId() }).catch(() => undefined);
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pairing, handlePayload, remoteSend]);

  useEffect(() => {
    if (!selectedKey) return;
    const session = sessions.find((item) => item.key === selectedKey);
    if (!session) return;
    void remoteSend({ type: "session:get", provider: session.provider, sessionId: session.id, requestId: requestId() })
      .catch((error) => setToast(error instanceof Error ? error.message : "无法读取会话"));
  }, [selectedKey, sessions, remoteSend]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const currentWindow = sessions.find((session) => session.currentWindow);
  const projectGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = sessions.filter((session) => !session.currentWindow).filter((session) => {
      if (!needle) return true;
      return `${session.title} ${session.cwd} ${session.provider}`.toLowerCase().includes(needle);
    });
    const map = new Map<string, { name: string; path: string; sessions: SessionSummary[]; updatedAt: number }>();
    for (const session of matches) {
      const path = session.projectPath || session.cwd || "未归类";
      const group = map.get(path) ?? { name: session.projectName || "未归类", path, sessions: [], updatedAt: 0 };
      group.sessions.push(session);
      group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
      map.set(path, group);
    }
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, query]);

  const selectedSummary = sessions.find((session) => session.key === selectedKey) ?? null;
  const selectedDetail = selectedKey ? details[selectedKey] : null;
  const messages = selectedKey ? [...(selectedDetail?.messages ?? []), ...(liveMessages[selectedKey] ?? [])] : [];

  useEffect(() => {
    if (!selectedKey) return;
    const timer = setTimeout(() => messageEndRef.current?.scrollIntoView({ block: "end" }), 40);
    return () => clearTimeout(timer);
  }, [selectedKey, messages.length, running]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedSummary || !draft.trim() || sending) return;
    if (!selectedSummary.currentWindow && mode === "full" && !window.confirm("完全控制会绕过本机权限确认。确定继续吗？")) return;
    const prompt = draft.trim();
    const remoteRequestId = requestId();
    const optimisticId = `local-${remoteRequestId}`;
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (selectedSummary.currentWindow) {
      waitingForReplyRef.current.set(selectedSummary.key, latestAssistant?.id ?? null);
    }
    setSending(true);
    setDraft("");
    setLiveMessages((value) => ({
      ...value,
      [selectedSummary.key]: [...(value[selectedSummary.key] ?? []), { id: optimisticId, role: "user", content: prompt }],
    }));
    optimisticRef.current.set(remoteRequestId, { sessionKey: selectedSummary.key, messageId: optimisticId });
    try {
      await remoteSend({
        type: "session:send",
        provider: selectedSummary.provider,
        sessionId: selectedSummary.id,
        prompt,
        mode,
        requestId: remoteRequestId,
      });
    } catch (error) {
      const optimistic = optimisticRef.current.get(remoteRequestId);
      if (optimistic) {
        setLiveMessages((value) => ({
          ...value,
          [optimistic.sessionKey]: (value[optimistic.sessionKey] ?? []).filter((message) => message.id !== optimistic.messageId),
        }));
        optimisticRef.current.delete(remoteRequestId);
      }
      waitingForReplyRef.current.delete(selectedSummary.key);
      setToast(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function forgetPhone() {
    if (!window.confirm("只清除此手机保存的绑定？电脑端仍会保留记录，可在电脑控制中心彻底解除。")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    setPairing(null);
  }

  if (!hydrated) return <main className="loading-shell"><div className="loading-mark">R</div></main>;
  if (!pairing) return <PairScreen onPaired={setPairing} />;

  return (
    <main className={`app-shell ${selectedKey ? "has-selection" : ""}`}>
      <aside className="session-panel">
        <header className="panel-header">
          <div className="brand-lockup"><div className="brand-mark brand-mark-small"><span>R</span></div><div><strong>RelayDesk</strong><span>你的远程 AI 工作台</span></div></div>
          <button className="icon-button" type="button" onClick={forgetPhone} title="管理此手机的连接" aria-label="管理此手机的连接">•••</button>
        </header>
        <div className="device-card"><span className={`status-pulse ${device?.online ? "online" : ""}`} /><div><strong>{device?.name ?? pairing.device.name}</strong><span>{device?.online ? "在线 · 回答自动同步" : "离线 · 等待电脑上线"}</span></div><button className="refresh-button" type="button" title="立即同步" aria-label="立即同步" onClick={() => void remoteSend({ type: "sessions:list", requestId: requestId() })}>↻</button></div>
        {currentWindow ? (
          <button className={`current-window ${selectedKey === currentWindow.key ? "selected" : ""}`} type="button" onClick={() => setSelectedKey(currentWindow.key)}>
            <span className="live-window-icon">›_</span><span><b>继续电脑当前任务</b><small>发送到当前 Codex · 回答自动回来</small></span><i className="online-pin" />
          </button>
        ) : null}
        <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或对话" /></label>
        <div className="project-heading"><span>项目与对话</span><b>{projectGroups.length} 个项目</b></div>
        <nav className="project-list" aria-label="项目和会话">
          {projectGroups.map((project) => {
            const isCollapsed = collapsed[project.path];
            return (
              <section className="project-group" key={project.path}>
                <button className="project-row" type="button" onClick={() => setCollapsed((value) => ({ ...value, [project.path]: !value[project.path] }))}>
                  <span className="folder-icon">⌑</span><span><strong>{project.name}</strong><small>{project.sessions.length} 个对话 · {project.path}</small></span><i>{isCollapsed ? "›" : "⌄"}</i>
                </button>
                {!isCollapsed ? <div className="project-sessions">{project.sessions.map((session) => (
                  <button className={`session-row ${selectedKey === session.key ? "selected" : ""}`} type="button" key={session.key} onClick={() => setSelectedKey(session.openInCodex && currentWindow ? currentWindow.key : session.key)}>
                    <span className={`provider-mark ${session.provider}`}>{session.provider === "codex" ? "C" : "A"}</span>
                    <span className="session-copy"><strong>{session.title}</strong><span>{session.openInCodex ? "正在电脑中打开 · 直接继续" : `${session.provider === "codex" ? "Codex" : "Claude Code"} · ${formatWhen(session.updatedAt)}`}</span></span>
                    {session.active || running[session.key] ? <i className="running-dot" /> : null}
                  </button>
                ))}</div> : null}
              </section>
            );
          })}
          {!projectGroups.length ? <div className="empty-list"><span>⌕</span><p>没有找到匹配的项目或会话</p></div> : null}
        </nav>
      </aside>

      <section className="conversation-panel">
        {selectedSummary ? (
          <>
            <header className="conversation-header">
              <button className="back-button" type="button" onClick={() => setSelectedKey(null)} aria-label="返回项目列表">‹</button>
              <span className={`provider-mark ${selectedSummary.provider}`}>{selectedSummary.provider === "codex" ? "C" : "A"}</span>
              <div className="conversation-title"><strong>{selectedSummary.currentWindow ? "电脑当前任务" : selectedSummary.title}</strong><span>{selectedSummary.currentWindow ? "Codex · 与电脑实时同步" : selectedSummary.cwd}</span></div>
              <span className={`sync-state ${device?.online ? "online" : ""}`}><i />{running[selectedSummary.key] === "waiting" ? "等待回复" : running[selectedSummary.key] ? "发送中" : device?.online ? "已连接" : "离线"}</span>
            </header>
            <div className="message-scroll">
              {!selectedDetail ? <div className="loading-conversation"><span /><span /><span /></div> : null}
              {messages.map((message) => message.role === "tool" ? (
                <details className="tool-message" key={message.id}><summary>工具记录</summary><div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div></details>
              ) : (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="message-avatar">{message.role === "user" ? "你" : selectedSummary.provider === "codex" ? "C" : "A"}</div>
                  <div className="message-content">
                    <div className="message-label"><b>{message.role === "user" ? "你" : selectedSummary.provider === "codex" ? "Codex" : "Claude"}</b>{formatMessageTime(message.timestamp) ? <time>{formatMessageTime(message.timestamp)}</time> : null}</div>
                    <div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                  </div>
                </article>
              ))}
              {running[selectedSummary.key] ? <div className="thinking-line"><span /><p>{running[selectedSummary.key] === "waiting" ? "Codex 正在电脑上思考，回答会自动出现在这里…" : selectedSummary.currentWindow ? "正在送达电脑当前窗口…" : "正在电脑上执行…"}</p></div> : null}
              <div ref={messageEndRef} className="message-end" />
            </div>
            <form className="composer" onSubmit={submit}>
              {!selectedSummary.currentWindow ? <><div className="background-target"><span><b>后台续聊</b><small>不会出现在电脑当前窗口</small></span>{currentWindow ? <button type="button" onClick={() => setSelectedKey(currentWindow.key)}>切到当前任务</button> : null}</div><div className="mode-switch"><button type="button" className={mode === "safe" ? "active" : ""} onClick={() => setMode("safe")}>安全模式</button><button type="button" className={mode === "full" ? "active danger" : ""} onClick={() => setMode("full")}>完全控制</button></div></> : <div className="window-target"><span>●</span>发送到电脑当前 Codex · 回答自动同步</div>}
              <div className="composer-input"><textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={running[selectedSummary.key] === "waiting" ? "正在等待 Codex 回复…" : selectedSummary.currentWindow ? "给 Codex 发一条指令…" : "继续这个对话…"} /><button type="submit" disabled={!draft.trim() || sending || Boolean(running[selectedSummary.key])} aria-label="发送">↑</button></div>
              <p>{selectedSummary.currentWindow ? "电脑端的回答会在几秒内自动显示在这里" : mode === "safe" ? "默认拒绝需要额外授权的操作" : "会绕过本机权限确认，请谨慎使用"}</p>
            </form>
          </>
        ) : (
          <div className="conversation-empty"><div className="empty-symbol">R</div><h2>从电脑离开的地方继续</h2><p>选择一个项目对话，或者直接打开电脑当前任务。消息和回答都会在两端保持同步。</p><div className="empty-badges"><span>永久绑定</span><span>端到端加密</span><span>自动同步</span></div></div>
        )}
      </section>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
