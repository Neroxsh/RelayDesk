"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  updatedAt: number;
  recent?: boolean;
  active?: boolean;
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
type DeviceStatus = { name: string; platform: string; online: boolean; lastSeenAt: number };
type RemotePayload = Record<string, unknown> & { type?: string; requestId?: string };
type PairApiResponse = {
  error?: string;
  clientId: string;
  clientToken: string;
  device: { id: string; name: string; platform: string; publicKey: JsonWebKey };
};
type ErrorApiResponse = { error?: string };
type PollApiResponse = ErrorApiResponse & {
  cursor?: number;
  device?: DeviceStatus | null;
  messages?: Array<{ kind: string; envelope: string }>;
};

const STORAGE_KEY = "relaydesk.pairing.v1";

function formatWhen(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function projectName(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "未知项目";
}

function PairScreen({ onPaired }: { onPaired: (pairing: StoredPairing) => void }) {
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function pair(event: FormEvent) {
    event.preventDefault();
    if (code.length !== 6 || working) return;
    setWorking(true);
    setError("");
    try {
      const codeHash = await sha256(code);
      const keys = await createPhoneKeys();
      const response = await fetch("/api/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeHash, publicKey: keys.publicKey }),
      });
      const data = (await response.json()) as PairApiResponse;
      if (!response.ok) throw new Error(data.error ?? "配对失败");
      const sessionKey = await deriveSessionKey(keys.privateKey, data.device.publicKey, codeHash);
      const pairing: StoredPairing = {
        clientId: data.clientId,
        clientToken: data.clientToken,
        key: await exportSessionKey(sessionKey),
        device: {
          id: data.device.id,
          name: data.device.name,
          platform: data.device.platform,
        },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
      onPaired(pairing);
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "配对失败，请重试");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="pair-shell">
      <div className="pair-orb pair-orb-one" />
      <div className="pair-orb pair-orb-two" />
      <section className="pair-card" aria-labelledby="pair-title">
        <div className="brand-mark" aria-hidden="true"><span>R</span></div>
        <p className="eyebrow">RelayDesk · 私人远程工作台</p>
        <h1 id="pair-title">电脑不在身边，工作还在手里。</h1>
        <p className="pair-lead">输入电脑端显示的 6 位配对码，接管你的 Codex 与 Claude Code 会话。</p>

        <form onSubmit={pair} className="pair-form">
          <label htmlFor="pair-code">配对码</label>
          <input
            id="pair-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            aria-describedby={error ? "pair-error" : undefined}
          />
          {error ? <p id="pair-error" className="form-error">{error}</p> : null}
          <button type="submit" disabled={code.length !== 6 || working}>
            {working ? "正在建立加密连接…" : "连接我的电脑"}
          </button>
        </form>

        <div className="security-note">
          <span className="lock-dot" aria-hidden="true">●</span>
          <div>
            <strong>端到端加密</strong>
            <p>会话内容只在你的手机和电脑上解密；配对码 10 分钟后失效。</p>
          </div>
        </div>
      </section>
      <p className="pair-foot">电脑端无需开放公网端口</p>
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
  const cursorRef = useRef(0);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<StoredPairing | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          setPairing(JSON.parse(raw) as StoredPairing);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
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
    if (!current) throw new Error("手机尚未配对");
    if (!keyRef.current) keyRef.current = await importSessionKey(current.key);
    const envelope = await encryptJson(keyRef.current, payload);
    const response = await fetch("/api/client/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${current.clientToken}`,
      },
      body: JSON.stringify({ envelope }),
    });
    const data = (await response.json().catch(() => ({}))) as ErrorApiResponse;
    if (!response.ok) throw new Error(data.error ?? "发送失败");
  }, []);

  const handlePayload = useCallback((payload: RemotePayload) => {
    if (payload.type === "sessions:snapshot" && Array.isArray(payload.sessions)) {
      setSessions(payload.sessions as SessionSummary[]);
      return;
    }
    if (payload.type === "session:snapshot" && payload.session) {
      const session = payload.session as SessionDetail;
      setDetails((current) => ({ ...current, [session.key]: session }));
      setLiveMessages((current) => ({ ...current, [session.key]: [] }));
      return;
    }
    if (payload.type === "run:status") {
      const key = String(payload.sessionKey ?? "");
      const status = String(payload.status ?? "");
      setRunning((current) => {
        const next = { ...current };
        if (status === "running" || status === "stopping") next[key] = status;
        else delete next[key];
        return next;
      });
      if (status === "failed") setToast(String(payload.error ?? "执行失败"));
      return;
    }
    if (payload.type === "run:event") {
      const key = String(payload.sessionKey ?? "");
      const event = payload.event as { type?: string; text?: string } | undefined;
      if (!key || !event?.text) return;
      const role: Message["role"] = event.type === "assistant" ? "assistant" : "tool";
      setLiveMessages((current) => ({
        ...current,
        [key]: [
          ...(current[key] ?? []),
          { id: `live-${Date.now()}-${Math.random()}`, role, content: event.text ?? "" },
        ].slice(-80),
      }));
      return;
    }
    if (payload.type === "request:error") setToast(String(payload.error ?? "请求失败"));
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function loop() {
      try {
        const current = pairingRef.current;
        if (!current) return;
        if (!keyRef.current) keyRef.current = await importSessionKey(current.key);
        const response = await fetch(`/api/client/poll?after=${cursorRef.current}`, {
          headers: { authorization: `Bearer ${current.clientToken}` },
          cache: "no-store",
        });
        const data = (await response.json()) as PollApiResponse;
        if (!response.ok) throw new Error(data.error ?? "连接失败");
        cursorRef.current = Number(data.cursor) || cursorRef.current;
        setDevice(data.device ?? null);
        for (const message of data.messages ?? []) {
          if (message.kind !== "encrypted") continue;
          const payload = (await decryptJson(keyRef.current, JSON.parse(message.envelope))) as RemotePayload;
          handlePayload(payload);
        }
      } catch (error) {
        if (!cancelled) setToast(error instanceof Error ? error.message : "连接暂时中断");
      } finally {
        if (!cancelled) timer = setTimeout(loop, document.visibilityState === "visible" ? 1_200 : 4_000);
      }
    }
    void loop();
    const kickoff = setTimeout(() => {
      void remoteSend({ type: "sessions:list", requestId: requestId() });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(kickoff);
    };
  }, [pairing, handlePayload, remoteSend]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      `${session.title} ${session.cwd} ${session.provider}`.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  const selected = sessions.find((session) => session.key === selectedKey) ?? null;
  const selectedDetail = selectedKey ? details[selectedKey] : null;
  const messages = selectedKey
    ? [...(selectedDetail?.messages ?? []), ...(liveMessages[selectedKey] ?? [])]
    : [];

  async function openSession(session: SessionSummary) {
    setSelectedKey(session.key);
    try {
      await remoteSend({
        type: "session:get",
        provider: session.provider,
        sessionId: session.id,
        requestId: requestId(),
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法打开会话");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim() || sending || running[selected.key]) return;
    if (mode === "full" && !window.confirm("完全控制会绕过 Codex / Claude 的权限确认。只应在你信任的项目中继续。")) return;
    const prompt = draft.trim();
    setDraft("");
    setSending(true);
    setLiveMessages((current) => ({
      ...current,
      [selected.key]: [
        ...(current[selected.key] ?? []),
        { id: `optimistic-${Date.now()}`, role: "user", content: prompt },
      ],
    }));
    try {
      await remoteSend({
        type: "session:send",
        provider: selected.provider,
        sessionId: selected.id,
        prompt,
        mode,
        requestId: requestId(),
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  function forgetDevice() {
    if (!window.confirm("从这台手机移除配对？电脑上的会话不会受影响。")) return;
    localStorage.removeItem(STORAGE_KEY);
    setPairing(null);
    setSessions([]);
    setDetails({});
    setSelectedKey(null);
  }

  if (!hydrated) return <main className="loading-shell"><div className="loading-mark">R</div></main>;
  if (!pairing) return <PairScreen onPaired={setPairing} />;

  return (
    <main className={`app-shell ${selected ? "has-selection" : ""}`}>
      <aside className="session-panel">
        <header className="panel-header">
          <div className="brand-lockup">
            <div className="brand-mark brand-mark-small" aria-hidden="true"><span>R</span></div>
            <div><strong>RelayDesk</strong><span>远程工作台</span></div>
          </div>
          <button className="icon-button" onClick={forgetDevice} aria-label="移除这台设备" title="移除配对">···</button>
        </header>

        <div className="device-card">
          <span className={`status-pulse ${device?.online ? "online" : ""}`} />
          <div><strong>{device?.name ?? pairing.device.name}</strong><span>{device?.online ? "在线 · 已加密" : "等待电脑连接"}</span></div>
          <button
            className="refresh-button"
            onClick={() => void remoteSend({ type: "sessions:list", requestId: requestId() }).catch((error) => setToast(error.message))}
            aria-label="刷新会话"
          >↻</button>
        </div>

        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话或项目" />
        </label>

        <div className="session-heading"><span>会话</span><span>{filteredSessions.length}</span></div>
        <nav className="session-list" aria-label="Codex 和 Claude 会话">
          {filteredSessions.map((session) => (
            <button
              key={session.key}
              className={`session-row ${selectedKey === session.key ? "selected" : ""}`}
              onClick={() => void openSession(session)}
            >
              <span className={`provider-mark ${session.provider}`}>{session.provider === "codex" ? "C" : "A"}</span>
              <span className="session-copy">
                <strong>{session.title}</strong>
                <span>{projectName(session.cwd)} · {formatWhen(session.updatedAt)}</span>
              </span>
              {(session.active || running[session.key]) ? <span className="running-dot" title="正在执行" /> : null}
            </button>
          ))}
          {!filteredSessions.length ? (
            <div className="empty-list"><span>⌁</span><p>{device?.online ? "还没有找到会话" : "电脑上线后会话会出现在这里"}</p></div>
          ) : null}
        </nav>
      </aside>

      <section className="conversation-panel">
        {selected ? (
          <>
            <header className="conversation-header">
              <button className="back-button" onClick={() => setSelectedKey(null)} aria-label="返回会话列表">‹</button>
              <span className={`provider-mark ${selected.provider}`}>{selected.provider === "codex" ? "C" : "A"}</span>
              <div className="conversation-title"><strong>{selected.title}</strong><span>{selected.cwd || "项目路径未知"}</span></div>
              {running[selected.key] ? (
                <button
                  className="stop-button"
                  onClick={() => void remoteSend({ type: "session:stop", provider: selected.provider, sessionId: selected.id, requestId: requestId() })}
                >停止</button>
              ) : null}
            </header>

            <div className="message-scroll">
              {!selectedDetail ? <div className="loading-conversation"><span /><span /><span /></div> : null}
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-label">{message.role === "user" ? "你" : message.role === "assistant" ? selected.provider === "codex" ? "Codex" : "Claude" : "工具"}</div>
                  <div className="message-body">{message.content}</div>
                </article>
              ))}
              {running[selected.key] ? <div className="thinking-line"><span /><p>{running[selected.key] === "stopping" ? "正在停止…" : "正在电脑上执行…"}</p></div> : null}
            </div>

            <form className="composer" onSubmit={submit}>
              <div className="mode-switch" aria-label="权限模式">
                <button type="button" className={mode === "safe" ? "active" : ""} onClick={() => setMode("safe")}>安全模式</button>
                <button type="button" className={mode === "full" ? "active danger" : ""} onClick={() => setMode("full")}>完全控制</button>
              </div>
              <div className="composer-input">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={`给 ${selected.provider === "codex" ? "Codex" : "Claude"} 发指令…`}
                  rows={1}
                  maxLength={12_000}
                />
                <button type="submit" disabled={!draft.trim() || sending || Boolean(running[selected.key])} aria-label="发送指令">↑</button>
              </div>
              <p>{mode === "safe" ? "默认拒绝需要额外授权的操作" : "将绕过本机权限确认，请谨慎使用"}</p>
            </form>
          </>
        ) : (
          <div className="conversation-empty">
            <div className="empty-symbol">R</div>
            <h2>选择一个会话继续</h2>
            <p>历史、当前进度和后续指令，会在手机与电脑之间实时同步。</p>
            <div className="empty-badges"><span>端到端加密</span><span>Codex</span><span>Claude Code</span></div>
          </div>
        )}
      </section>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
