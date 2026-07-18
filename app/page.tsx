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

const PROVIDERS: Record<Provider, { name: string; short: string; description: string }> = {
  codex: { name: "Codex", short: "C", description: "OpenAI" },
  claude: { name: "Claude Code", short: "Cl", description: "Anthropic" },
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

function providerName(provider: Provider) {
  return PROVIDERS[provider].name;
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
        <p className="eyebrow">RelayDesk</p>
        {pending ? (
          <div className="approval-state">
            <div className="approval-icon"><span /></div>
            <span className="pair-kicker">连接请求已发送</span>
            <h1 id="pair-title">在电脑上确认</h1>
            <p>打开 <strong>{pending.deviceName}</strong> 上的 RelayDesk，确认这台手机。</p>
            <div className="approval-steps"><span className="approval-pulse" /><b>等待电脑确认</b><i>10 分钟内有效</i></div>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="text-button" type="button" onClick={cancelPending}>换一个连接码</button>
          </div>
        ) : (
          <>
            <span className="pair-kicker">Remote workspace</span>
            <h1 id="pair-title">连接你的电脑</h1>
            <p className="pair-lead">输入电脑端显示的 16 位连接码。</p>
            <form onSubmit={requestPair} className="pair-form">
              <label htmlFor="pair-key">连接码</label>
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
                {working ? "正在连接…" : "继续"}
              </button>
            </form>
            <div className="security-note"><span>✓</span><div><strong>这台手机会保持连接</strong><p>可随时在电脑端移除。</p></div></div>
          </>
        )}
      </section>
      <p className="pair-foot"><span /> 端到端加密</p>
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
  const [activeProvider, setActiveProvider] = useState<Provider>("codex");
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
          setToast(`${providerName(session.provider)} 已回复`);
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
      if (status === "submitted") setToast("电脑已接收");
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
  const providerCounts = useMemo(() => ({
    codex: sessions.filter((session) => session.provider === "codex" && !session.currentWindow).length,
    claude: sessions.filter((session) => session.provider === "claude").length,
  }), [sessions]);
  const projectGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = sessions.filter((session) => !session.currentWindow && session.provider === activeProvider).filter((session) => {
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
  }, [sessions, query, activeProvider]);

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
    if (!selectedSummary.currentWindow && mode === "full" && !window.confirm("“放开权限”会跳过电脑端确认。继续？")) return;
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
    if (!window.confirm("从这台手机移除 RelayDesk？")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    setPairing(null);
  }

  function switchProvider(provider: Provider) {
    setActiveProvider(provider);
    setSelectedKey(null);
    setQuery("");
  }

  if (!hydrated) return <main className="loading-shell"><div className="loading-mark">R</div></main>;
  if (!pairing) return <PairScreen onPaired={setPairing} />;

  return (
    <main className={`app-shell ${selectedKey ? "has-selection" : ""}`} data-provider={activeProvider}>
      <aside className="provider-rail" aria-label="工作区">
        <div className="rail-brand" aria-label="RelayDesk">R</div>
        <nav className="provider-switcher" aria-label="选择工具">
          {(["codex", "claude"] as Provider[]).map((provider) => (
            <button className={`provider-switch ${provider} ${activeProvider === provider ? "active" : ""}`} type="button" key={provider} onClick={() => switchProvider(provider)} aria-pressed={activeProvider === provider}>
              <span>{PROVIDERS[provider].short}</span>
              <em>{provider === "codex" ? "Codex" : "Claude"}</em>
              <i>{providerCounts[provider]}</i>
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <span className={`rail-online ${device?.online ? "online" : ""}`} title={device?.online ? "电脑在线" : "电脑离线"} />
          <button type="button" onClick={forgetPhone} title="移除此手机" aria-label="移除此手机">···</button>
        </div>
      </aside>

      <aside className="session-panel">
        <header className="panel-header">
          <div className="workspace-title"><span>{PROVIDERS[activeProvider].short}</span><div><strong>{providerName(activeProvider)}</strong><small>{PROVIDERS[activeProvider].description}</small></div></div>
          <span className={`device-state ${device?.online ? "online" : ""}`}><i />{device?.online ? "在线" : "离线"}</span>
        </header>

        <div className="device-card">
          <div className="device-copy"><span className="device-glyph">⌁</span><span><strong>{device?.name ?? pairing.device.name}</strong><small>{device?.online ? "已连接" : "等待电脑"}</small></span></div>
          <button className="refresh-button" type="button" title="同步" aria-label="同步" onClick={() => void remoteSend({ type: "sessions:list", requestId: requestId() })}>↻</button>
        </div>

        {activeProvider === "codex" && currentWindow ? (
          <button className={`current-window ${selectedKey === currentWindow.key ? "selected" : ""}`} type="button" onClick={() => setSelectedKey(currentWindow.key)}>
            <span className="live-window-icon">›_</span>
            <span><b>当前 Codex</b><small>电脑前台</small></span>
            <i className="live-badge">LIVE</i>
          </button>
        ) : null}

        <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索 ${providerName(activeProvider)}`} /></label>
        <div className="project-heading"><span>项目</span><b>{projectGroups.length}</b></div>
        <nav className="project-list" aria-label={`${providerName(activeProvider)} 项目和会话`}>
          {projectGroups.map((project) => {
            const collapseKey = `${activeProvider}:${project.path}`;
            const isCollapsed = collapsed[collapseKey];
            return (
              <section className="project-group" key={collapseKey}>
                <button className="project-row" type="button" onClick={() => setCollapsed((value) => ({ ...value, [collapseKey]: !value[collapseKey] }))}>
                  <span className="folder-icon">⌑</span>
                  <span><strong>{project.name}</strong><small>{project.path}</small></span>
                  <i className="project-count">{project.sessions.length}</i>
                  <i className="project-chevron">{isCollapsed ? "›" : "⌄"}</i>
                </button>
                {!isCollapsed ? <div className="project-sessions">{project.sessions.map((session) => (
                  <button className={`session-row ${selectedKey === session.key ? "selected" : ""}`} type="button" key={session.key} onClick={() => setSelectedKey(session.openInCodex && currentWindow ? currentWindow.key : session.key)}>
                    <span className="session-track" />
                    <span className="session-copy"><strong>{session.title}</strong><span>{session.openInCodex ? "电脑前台" : formatWhen(session.updatedAt)}</span></span>
                    {session.active || running[session.key] ? <i className="running-dot" /> : null}
                  </button>
                ))}</div> : null}
              </section>
            );
          })}
          {!projectGroups.length ? <div className="empty-list"><span>—</span><p>{query ? "没有匹配结果" : `还没有 ${providerName(activeProvider)} 会话`}</p></div> : null}
        </nav>
      </aside>

      <section className="conversation-panel">
        {selectedSummary ? (
          <>
            <header className="conversation-header">
              <button className="back-button" type="button" onClick={() => setSelectedKey(null)} aria-label="返回项目列表">‹</button>
              <span className={`provider-mark ${selectedSummary.provider}`}>{PROVIDERS[selectedSummary.provider].short}</span>
              <div className="conversation-title"><strong>{selectedSummary.currentWindow ? "当前 Codex" : selectedSummary.title}</strong><span>{selectedSummary.currentWindow ? "电脑前台" : selectedSummary.cwd}</span></div>
              <span className={`sync-state ${device?.online ? "online" : ""}`}><i />{running[selectedSummary.key] === "waiting" ? "等回复" : running[selectedSummary.key] ? "执行中" : device?.online ? "已连接" : "离线"}</span>
            </header>

            <div className="message-scroll">
              {!selectedDetail ? <div className="loading-conversation"><span /><span /><span /></div> : null}
              {messages.map((message) => message.role === "tool" ? (
                <details className="tool-message" key={message.id}><summary><span>⌘</span>运行记录</summary><div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div></details>
              ) : (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="message-avatar">{message.role === "user" ? "你" : PROVIDERS[selectedSummary.provider].short}</div>
                  <div className="message-content">
                    <div className="message-label"><b>{message.role === "user" ? "你" : providerName(selectedSummary.provider)}</b>{formatMessageTime(message.timestamp) ? <time>{formatMessageTime(message.timestamp)}</time> : null}</div>
                    <div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                  </div>
                </article>
              ))}
              {running[selectedSummary.key] ? <div className="thinking-line"><span /><p>{running[selectedSummary.key] === "waiting" ? `${providerName(selectedSummary.provider)} 正在处理` : selectedSummary.currentWindow ? "发送到电脑" : "正在运行"}</p></div> : null}
              <div ref={messageEndRef} className="message-end" />
            </div>

            <form className="composer" onSubmit={submit}>
              <div className="composer-meta">
                {selectedSummary.currentWindow ? (
                  <span className="window-target"><i />电脑前台</span>
                ) : (
                  <><span className="background-target"><i />后台会话</span><div className="mode-switch"><button type="button" className={mode === "safe" ? "active" : ""} onClick={() => setMode("safe")}>受控</button><button type="button" className={mode === "full" ? "active danger" : ""} onClick={() => setMode("full")}>放开权限</button></div></>
                )}
              </div>
              <div className="composer-input"><textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={running[selectedSummary.key] === "waiting" ? "等待回复" : `给 ${providerName(selectedSummary.provider)} 发消息`} /><button type="submit" disabled={!draft.trim() || sending || Boolean(running[selectedSummary.key])} aria-label="发送">↗</button></div>
              <p>Enter 发送 · Shift + Enter 换行</p>
            </form>
          </>
        ) : (
          <div className="conversation-empty">
            <div className={`empty-provider ${activeProvider}`}>{PROVIDERS[activeProvider].short}</div>
            <span>{PROVIDERS[activeProvider].description}</span>
            <h2>{providerName(activeProvider)}</h2>
            <p>从左侧选择一个项目。</p>
            {activeProvider === "codex" && currentWindow ? <button type="button" onClick={() => setSelectedKey(currentWindow.key)}>打开当前 Codex <i>↗</i></button> : null}
          </div>
        )}
      </section>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
