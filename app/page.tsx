"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationView, EmptyConversation } from "./components/conversation-view";
import { PairingScreen } from "./components/pairing-screen";
import { SessionBrowser } from "./components/session-browser";
import { decryptJson, encryptJson, importSessionKey, requestId } from "./remote-crypto";
import {
  cursorKey,
  LEGACY_STORAGE_KEY,
  messageSignature,
  providerName,
  STORAGE_KEY,
} from "./relaydesk-meta";
import type {
  DeviceStatus,
  Message,
  PermissionMode,
  PollResponse,
  ProjectGroup,
  Provider,
  RemotePayload,
  SessionDetail,
  SessionSummary,
  StoredPairing,
} from "./relaydesk-types";

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
  const [mode, setMode] = useState<PermissionMode>("safe");
  const [running, setRunning] = useState<Record<string, string>>({});
  const [liveMessages, setLiveMessages] = useState<Record<string, Message[]>>({});
  const [toast, setToast] = useState("");
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const cursorRef = useRef(0);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<StoredPairing | null>(null);
  const detailsRef = useRef<Record<string, SessionDetail>>({});
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
    let refreshing = false;
    const refreshForUpdate = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", refreshForUpdate);
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
        registration.waiting?.postMessage({ type: "SKIP_WAITING" });
        void registration.update();
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      }).catch(() => undefined);
    }
    return () => {
      clearTimeout(timer);
      navigator.serviceWorker?.removeEventListener("controllerchange", refreshForUpdate);
    };
  }, []);

  useEffect(() => {
    pairingRef.current = pairing;
    keyRef.current = null;
    cursorRef.current = pairing ? Number(localStorage.getItem(cursorKey(pairing.clientId)) ?? 0) || 0 : 0;
  }, [pairing]);

  const remoteSend = useCallback(async (payload: RemotePayload) => {
    const current = pairingRef.current;
    if (!current) throw new Error("手机尚未连接");
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
      const previous = detailsRef.current[session.key];
      const previousSignatures = new Set((previous?.messages ?? []).map(messageSignature));
      const additions = session.messages.filter((message) => !previousSignatures.has(messageSignature(message)));
      detailsRef.current = { ...detailsRef.current, [session.key]: session };
      setDetails(detailsRef.current);

      if (additions.length) {
        setLiveMessages((value) => {
          const available = additions.map((message) => `${message.role}\u0000${message.content}`);
          return {
            ...value,
            [session.key]: (value[session.key] ?? []).filter((message) => {
              const index = available.indexOf(`${message.role}\u0000${message.content}`);
              if (index < 0) return true;
              available.splice(index, 1);
              return false;
            }),
          };
        });
      }

      if (waitingForReplyRef.current.has(session.key)) {
        const baseline = waitingForReplyRef.current.get(session.key);
        const latestAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        const latestSignature = latestAssistant ? messageSignature(latestAssistant) : null;
        if (latestSignature && latestSignature !== baseline) {
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
      if (status === "submitted") setToast("电脑已收到");
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
          localStorage.removeItem(cursorKey(pairing.clientId));
          if (!stopped) { setPairing(null); setToast("这台手机的连接已被移除"); }
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
        localStorage.setItem(cursorKey(pairing.clientId), String(cursorRef.current));
        if (!stopped) timer = setTimeout(poll, document.visibilityState === "visible" ? 700 : 2_500);
      } catch (error) {
        if (!stopped) {
          setToast(error instanceof Error ? error.message : "连接暂时中断");
          timer = setTimeout(poll, 2_500);
        }
      }
    };
    void remoteSend({ type: "sessions:list", requestId: requestId() }).catch(() => undefined);
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pairing, handlePayload, remoteSend]);

  const currentWindow = sessions.find((session) => session.currentWindow);
  const selectedSummary = sessions.find((session) => session.key === selectedKey) ?? null;
  const selectedSessionId = selectedSummary?.id;
  const selectedProvider = selectedSummary?.provider;

  useEffect(() => {
    if (!pairing || !selectedSessionId || !selectedProvider) return;
    const watch = () => remoteSend({
      type: "session:watch",
      provider: selectedProvider,
      sessionId: selectedSessionId,
      requestId: requestId(),
    }).catch((error) => setToast(error instanceof Error ? error.message : "无法同步会话"));
    void watch();
    const timer = window.setInterval(watch, 12_000);
    const resume = () => { if (document.visibilityState === "visible") void watch(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", watch);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", watch);
    };
  }, [pairing, selectedSessionId, selectedProvider, remoteSend]);

  const selectedMessageCount = selectedKey ? details[selectedKey]?.messages.length ?? 0 : 0;
  const selectedLiveMessageCount = selectedKey ? liveMessages[selectedKey]?.length ?? 0 : 0;

  useEffect(() => {
    if (!selectedKey) return;
    const timer = setTimeout(() => messageEndRef.current?.scrollIntoView({ block: "end" }), 50);
    return () => clearTimeout(timer);
  }, [selectedKey, selectedMessageCount, selectedLiveMessageCount]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3_200);
    return () => clearTimeout(timer);
  }, [toast]);

  const providerCounts = useMemo(() => ({
    codex: sessions.filter((session) => session.provider === "codex" && !session.currentWindow).length,
    claude: sessions.filter((session) => session.provider === "claude").length,
  }), [sessions]);

  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = sessions
      .filter((session) => !session.currentWindow && session.provider === activeProvider)
      .filter((session) => !needle || `${session.title} ${session.cwd}`.toLowerCase().includes(needle));
    const map = new Map<string, ProjectGroup>();
    for (const session of matches) {
      const path = session.projectPath || session.cwd || "未归类";
      const group = map.get(path) ?? { name: session.projectName || "未归类", path, sessions: [], updatedAt: 0 };
      group.sessions.push(session);
      group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
      map.set(path, group);
    }
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, query, activeProvider]);

  const selectedDetail = selectedKey ? details[selectedKey] : null;
  const messages = selectedKey ? [...(selectedDetail?.messages ?? []), ...(liveMessages[selectedKey] ?? [])] : [];

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedSummary || !draft.trim() || sending) return;
    if (!selectedSummary.currentWindow && mode === "full" && !window.confirm("自动执行会跳过电脑端的逐项确认。继续？")) return;
    const prompt = draft.trim();
    const remoteRequestId = requestId();
    const optimisticId = `local-${remoteRequestId}`;
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    waitingForReplyRef.current.set(selectedSummary.key, latestAssistant ? messageSignature(latestAssistant) : null);
    setSending(true);
    setRunning((value) => ({ ...value, [selectedSummary.key]: "sending" }));
    setDraft("");
    setLiveMessages((value) => ({
      ...value,
      [selectedSummary.key]: [...(value[selectedSummary.key] ?? []), { id: optimisticId, role: "user", content: prompt, pending: true }],
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
      setRunning((value) => {
        const next = { ...value };
        delete next[selectedSummary.key];
        return next;
      });
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
    if (!pairing || !window.confirm("从这台手机移除 RelayDesk？")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(cursorKey(pairing.clientId));
    setPairing(null);
  }

  function switchProvider(provider: Provider) {
    setActiveProvider(provider);
    setSelectedKey(null);
    setQuery("");
  }

  function selectSession(session: SessionSummary) {
    if (session.openInCodex && currentWindow) {
      setSelectedKey(currentWindow.key);
      return;
    }
    setSelectedKey(session.key);
  }

  function stopSession() {
    if (!selectedSummary) return;
    void remoteSend({ type: "session:stop", provider: selectedSummary.provider, sessionId: selectedSummary.id, requestId: requestId() })
      .then(() => setToast("正在停止"))
      .catch((error) => setToast(error instanceof Error ? error.message : "无法停止任务"));
  }

  if (!hydrated) return <main className="loading-shell"><strong>RelayDesk</strong><span>正在连接电脑…</span></main>;
  if (!pairing) return <PairingScreen onPaired={setPairing} />;

  return (
    <main className={`app-shell ${selectedSummary ? "has-selection" : ""}`} data-provider={activeProvider}>
      <SessionBrowser
        activeProvider={activeProvider}
        providerCounts={providerCounts}
        device={device}
        pairing={pairing}
        currentWindow={currentWindow}
        selectedKey={selectedKey}
        query={query}
        projectGroups={projectGroups}
        collapsed={collapsed}
        running={running}
        onProviderChange={switchProvider}
        onSelect={selectSession}
        onQueryChange={setQuery}
        onRefresh={() => void remoteSend({ type: "sessions:list", requestId: requestId() })}
        onForgetPhone={forgetPhone}
        setCollapsed={setCollapsed}
      />

      {selectedSummary ? (
        <ConversationView
          session={selectedSummary}
          detail={selectedDetail}
          messages={messages}
          device={device}
          runningStatus={running[selectedSummary.key]}
          draft={draft}
          mode={mode}
          sending={sending}
          messageEndRef={messageEndRef}
          onBack={() => setSelectedKey(null)}
          onDraftChange={setDraft}
          onModeChange={setMode}
          onSubmit={submit}
          onKeyDown={keyDown}
          onStop={stopSession}
        />
      ) : <EmptyConversation provider={activeProvider} />}

      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
