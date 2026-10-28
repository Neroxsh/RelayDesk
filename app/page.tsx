"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationView, EmptyConversation } from "./components/conversation-view";
import { CodexSettings } from "./components/codex-settings";
import { ClaudeSettings } from "./components/claude-settings";
import { PairingScreen } from "./components/pairing-screen";
import { SessionLoader } from "./components/session-loader";
import { SessionBrowser } from "./components/session-browser";
import { decryptJson, encryptJson, importSessionKey, requestId } from "./remote-crypto";
import { outboxMessage, readDraft, readOutbox, writeDraft, writeOutbox } from "./client-storage";
import {
  cursorKey,
  LEGACY_STORAGE_KEY,
  mergeSessionMessages,
  messageSignature,
  providerName,
  STORAGE_KEY,
} from "./relaydesk-meta";
import type {
  DeviceStatus,
  CodexStatus,
  ClaudeStatus,
  Provider,
  Message,
  OutboxEntry,
  PollResponse,
  ProjectGroup,
  RemotePayload,
  RunSettings,
  SessionDetail,
  SessionSummary,
  StoredPairing,
} from "./relaydesk-types";

export default function Home() {
  const [pairing, setPairing] = useState<StoredPairing | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [agentContactAt, setAgentContactAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [browserProvider, setBrowserProvider] = useState<Provider>("codex");
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [settings, setSettings] = useState<RunSettings>({ model: "", reasoning: "", permission: "workspace", serviceTier: "" });
  const [settingsCustomized, setSettingsCustomized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(8);
  const [loadingLabel, setLoadingLabel] = useState("正在连接电脑");
  const [running, setRunning] = useState<Record<string, string>>({});
  const [liveMessages, setLiveMessages] = useState<Record<string, Message[]>>({});
  const [toast, setToast] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const cursorRef = useRef(0);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<StoredPairing | null>(null);
  const detailsRef = useRef<Record<string, SessionDetail>>({});
  const waitingForReplyRef = useRef(new Map<string, string | null>());
  const deliveryAcksRef = useRef(new Map<string, () => void>());
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const outboxRef = useRef(new Map<string, OutboxEntry>());
  const seenEventsRef = useRef(new Set<string>());
  const queryPendingRef = useRef<(() => void) | null>(null);
  const transportCountRef = useRef(0);

  const updateOutbox = useCallback((id: string, patch?: Partial<OutboxEntry>, remove = false) => {
    const entry = outboxRef.current.get(id);
    if (!entry) return;
    if (remove) outboxRef.current.delete(id);
    else outboxRef.current.set(id, { ...entry, ...patch });
    const current = pairingRef.current;
    if (current) {
      try { writeOutbox(localStorage, current.clientId, [...outboxRef.current.values()]); }
      catch { setToast("浏览器无法保存消息回执，请保留当前页面"); }
    }
    if (!remove) {
      const next = outboxRef.current.get(id)!;
      setLiveMessages((value) => ({ ...value, [next.sessionKey]: (value[next.sessionKey] ?? []).map((message) => message.requestId === id ? outboxMessage(next) : message) }));
    }
  }, []);

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
    const timer = window.setInterval(() => setClock(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    pairingRef.current = pairing;
    keyRef.current = null;
    cursorRef.current = pairing ? Number(localStorage.getItem(cursorKey(pairing.clientId)) ?? 0) || 0 : 0;
    seenEventsRef.current.clear();
    outboxRef.current.clear();
    if (pairing) {
      const restored = readOutbox(localStorage, pairing.clientId);
      const echoes: Record<string, Message[]> = {};
      for (const entry of restored) {
        outboxRef.current.set(entry.requestId, entry);
        (echoes[entry.sessionKey] ??= []).push(outboxMessage(entry));
      }
      const restoreTimer = window.setTimeout(() => {
        setLiveMessages(echoes);
        try {
          const previousSession = localStorage.getItem(`relaydesk.selected.${pairing.clientId}`);
          if (previousSession) { setSelectedKey(previousSession); setDraft(readDraft(localStorage, pairing.clientId, previousSession)); }
        } catch { /* Session restoration is optional. */ }
      }, 0);
      return () => window.clearTimeout(restoreTimer);
    }
  }, [pairing]);

  const remoteSend = useCallback(async (payload: RemotePayload) => {
    const current = pairingRef.current;
    if (!current) throw new Error("手机尚未连接");
    if (!keyRef.current) keyRef.current = await importSessionKey(current.key);
    const envelope = await encryptJson(keyRef.current, payload);
    let lastError = "中继暂时不稳定";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch("/api/client/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${current.clientToken}`,
            "x-relaydesk-client-id": current.clientId,
          },
          body: JSON.stringify({ envelope, deliveryId: payload.attemptId ?? payload.requestId }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({})) as { error?: string };
        if (response.ok) return;
        lastError = data.error ?? lastError;
        if (response.status < 500 && response.status !== 429) {
          const error = new Error(lastError) as Error & { permanent?: boolean };
          error.permanent = true;
          throw error;
        }
      } catch (error) {
        if ((error as Error & { permanent?: boolean }).permanent) throw error;
        lastError = controller.signal.aborted
          ? "连接超时"
          : error instanceof Error ? error.message : lastError;
      } finally {
        window.clearTimeout(timeout);
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
    throw new Error(lastError.includes("545") ? "中继暂时不稳定，请再试一次" : lastError);
  }, []);

  const handlePayload = useCallback((payload: RemotePayload) => {
    if (typeof payload.eventId === "string") {
      if (seenEventsRef.current.has(payload.eventId)) return;
      seenEventsRef.current.add(payload.eventId);
      if (seenEventsRef.current.size > 1_000) seenEventsRef.current.delete(seenEventsRef.current.values().next().value!);
    }
    if (payload.type === "sessions:loading") {
      setSessionsLoading(true);
      setLoadingProgress(Math.max(4, Math.min(96, Number(payload.progress) || 12)));
      setLoadingLabel(String(payload.label ?? "正在读取 Codex 会话"));
      return;
    }

    if (payload.type === "codex:status" && payload.status) {
      const status = payload.status as CodexStatus;
      setCodexStatus(status);
      setStatusError("");
      return;
    }
    if (payload.type === "codex:status:error") { setStatusError(String(payload.error ?? "用量暂不可用")); return; }
    if (payload.type === "claude:status" && payload.status) {
      setClaudeStatus((previous) => !previous || Number((payload.status as ClaudeStatus).updatedAt) >= previous.updatedAt ? payload.status as ClaudeStatus : previous);
      if (payload.switched) { setSwitchingProvider(false); setSettingsCustomized(false); setToast("电脑的 Claude 全局供应商已切换"); }
      return;
    }
    if (payload.type === "session:created" && payload.session) {
      const session = payload.session as SessionSummary;
      setSessions((previous) => [session, ...previous.filter((item) => item.key !== session.key)]);
      setBrowserProvider(session.provider); setSelectedKey(session.key); setDraft(""); setSettingsCustomized(false);
      return;
    }

    if (payload.type === "sessions:snapshot" && Array.isArray(payload.sessions)) {
      setSessions(payload.sessions as SessionSummary[]);
      setLoadingProgress(100);
      setSessionsLoading(false);
      void remoteSend({
        type: "sessions:ack",
        count: payload.sessions.length,
        requestId: requestId(),
      }).catch(() => undefined);
      return;
    }

    if (payload.type === "session:snapshot" && payload.session) {
      const session = payload.session as SessionDetail;
      const previous = detailsRef.current[session.key];
      if (previous && session.updatedAt < previous.updatedAt) return;
      const previousSignatures = new Set((previous?.messages ?? []).map(messageSignature));
      const additions = session.messages.filter((message) => !previousSignatures.has(messageSignature(message)));
      const mergedSession = {
        ...previous,
        ...session,
        messages: mergeSessionMessages(previous?.messages ?? [], session.messages),
      };
      detailsRef.current = { ...detailsRef.current, [session.key]: mergedSession };
      setDetails(detailsRef.current);
      const echoes = [...outboxRef.current.values()].filter((entry) => entry.sessionKey === session.key).map(outboxMessage);
      const unresolved = new Set(mergeSessionMessages(session.messages, echoes).map((message) => message.id));
      for (const entry of [...outboxRef.current.values()]) {
        if (entry.sessionKey === session.key && !unresolved.has(`local-${entry.requestId}`)) updateOutbox(entry.requestId, undefined, true);
      }

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
        const latestAssistant = [...mergedSession.messages].reverse().find((message) => message.role === "assistant");
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
      const message: Message = { id: String(payload.eventId ?? `${Date.now()}-${Math.random()}`), role, content: event.text ?? "", timestamp: new Date(Number(payload.at) || Date.now()).toISOString() };
      setLiveMessages((value) => ({
        ...value,
        [payload.sessionKey as string]: [...(value[payload.sessionKey as string] ?? []), message],
      }));
      return;
    }

    if (payload.type === "run:status" && payload.sessionKey) {
      const key = payload.sessionKey as string;
      const status = String(payload.status ?? "");
      const entry = payload.requestId ? outboxRef.current.get(payload.requestId) : null;
      if (entry && Number(payload.at) < entry.updatedAt) return;
      if (payload.requestId) deliveryAcksRef.current.get(payload.requestId)?.();
      if (payload.requestId) updateOutbox(payload.requestId, {
        status, error: typeof payload.error === "string" ? payload.error : undefined,
        updatedAt: Number(payload.at) || 0,
      });
      // A canonical user message is stronger evidence than a late IPC response.
      // Once its local echo has reconciled, old receipts must not reopen a spinner.
      if (!entry && payload.requestId) return;
      setRunning((value) => {
        const next = { ...value };
        if (["completed", "failed", "uncertain"].includes(status)) delete next[key];
        else next[key] = status === "submitted" ? "waiting" : status;
        return next;
      });
      if (status === "failed") {
        waitingForReplyRef.current.delete(key);
        setToast(String(payload.error ?? "电脑端执行失败"));
      }
      if (status === "submitted") setToast("电脑已收到");
      return;
    }
    if (payload.type === "request:unknown" && payload.requestId) {
      updateOutbox(payload.requestId, { status: "retryable", error: "电脑尚未收到这条消息，可以重新发送" });
      if (payload.sessionKey) setRunning((value) => { const next = { ...value }; delete next[String(payload.sessionKey)]; return next; });
      return;
    }

    if (payload.type === "request:error") {
      setSwitchingProvider(false);
      if (payload.requestId) deliveryAcksRef.current.get(payload.requestId)?.();
      if (payload.requestId) updateOutbox(payload.requestId, { status: "failed", error: String(payload.error ?? "请求失败") });
      setToast(String(payload.error ?? "请求失败"));
      const key = payload.sessionKey as string | undefined;
      if (key) setRunning((value) => { const next = { ...value }; delete next[key]; return next; });
    }
  }, [remoteSend, updateOutbox]);

  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let pollInFlight = false;
    let pollController: AbortController | null = null;
    let failures = 0;
    const schedule = (delay: number) => {
      if (!stopped) {
        clearTimeout(timer);
        timer = setTimeout(poll, delay);
      }
    };
    const poll = async () => {
      if (stopped || pollInFlight) return;
      if (!navigator.onLine) { setConnectionError("网络已断开，恢复后会自动重连"); schedule(5_000); return; }
      pollInFlight = true;
      const controller = new AbortController();
      pollController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`/api/client/poll?after=${cursorRef.current}`, {
          headers: {
            authorization: `Bearer ${pairing.clientToken}`,
            "x-relaydesk-client-id": pairing.clientId,
          },
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json().catch(() => {
          throw new Error(response.ok ? "服务返回异常，正在重连" : `连接失败（${response.status}）`);
        }) as PollResponse;
        if (response.status === 401) {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          localStorage.removeItem(cursorKey(pairing.clientId));
          if (!stopped) { setPairing(null); setToast("这台手机的连接已被移除"); }
          return;
        }
        if (!response.ok) throw new Error(data.error ?? "同步失败");
        if (!stopped) { failures = 0; setConnectionError(""); }
        if (!stopped && data.device) {
          setDevice(data.device);
          // A successful poll is also a fresh view of the agent heartbeat. Keep a
          // short grace window so a single relay hiccup does not flip the UI offline.
          if (data.device.online) setAgentContactAt(Date.now());
        }
        if (!keyRef.current) keyRef.current = await importSessionKey(pairing.key);
        for (const message of data.messages ?? []) {
          if (message.kind !== "encrypted") { cursorRef.current = Math.max(cursorRef.current, Number(message.id) || 0); continue; }
          const payload = await decryptJson(keyRef.current, JSON.parse(message.envelope)) as RemotePayload;
          if (!stopped) {
            setAgentContactAt(Date.now());
            handlePayload(payload);
          }
          cursorRef.current = Math.max(cursorRef.current, Number(message.id) || 0);
        }
        localStorage.setItem(cursorKey(pairing.clientId), String(cursorRef.current));
        schedule((data.messages?.length ?? 0) >= 100 ? 50 : document.visibilityState === "visible" ? 1_200 : 10_000);
      } catch {
        failures += 1;
        if (!stopped) setConnectionError("同步暂时中断，正在自动重连；待发送消息会保留");
        schedule(Math.min(10_000, 1_000 * 2 ** Math.min(failures, 3)));
      } finally {
        window.clearTimeout(timeout);
        pollController = null;
        pollInFlight = false;
      }
    };
    void remoteSend({ type: "sessions:list", requestId: requestId() }).catch(() => undefined);
    void remoteSend({ type: "ping", requestId: requestId() }).catch(() => undefined);
    const sessionTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void remoteSend({ type: "sessions:list", background: true, requestId: requestId() }).catch(() => undefined);
      }
    }, 30_000);
    let queryingPending = false;
    const queryPending = () => {
      if (queryingPending || stopped) return;
      const entries = [...outboxRef.current.values()].filter((entry) => !["failed", "retryable"].includes(entry.status));
      if (!entries.length) return;
      queryingPending = true;
      void Promise.allSettled(entries.slice(-10).map((entry) => remoteSend({
        type: "request:status", originalRequestId: entry.requestId, sessionKey: entry.sessionKey, requestId: requestId(),
      }))).finally(() => { queryingPending = false; });
    };
    queryPendingRef.current = queryPending;
    void queryPending();
    const pingTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void remoteSend({ type: "ping", requestId: requestId() }).catch(() => undefined);
        queryPending();
      }
    }, 15_000);
    const resume = () => {
      if (document.visibilityState === "visible" || navigator.onLine) {
        clearTimeout(timer);
        pollController?.abort();
        schedule(100);
        queryPending();
        void remoteSend({ type: "codex:status:get", requestId: requestId() }).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    void poll();
    return () => {
      stopped = true;
      pollController?.abort();
      queryPendingRef.current = null;
      clearTimeout(timer);
      clearInterval(sessionTimer);
      clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [pairing, handlePayload, remoteSend]);

  const currentWindow = sessions.find((session) => session.currentWindow);
  const visibleDevice = useMemo<DeviceStatus | null>(() => device ? {
    ...device,
    // Allow a few relay intervals for mobile networks, background tabs and
    // transient 5xx responses. A truly stopped agent will still turn offline.
    online: device.online || (agentContactAt > 0 && clock - agentContactAt < 180_000),
  } : null, [device, agentContactAt, clock]);
  const selectedSummary = sessions.find((session) => session.key === selectedKey) ?? null;
  const activeProvider = selectedSummary?.provider ?? browserProvider;
  const selectedSessionId = selectedSummary?.id;
  const selectedProvider = selectedSummary?.provider;

  useEffect(() => {
    if (!switchingProvider) return;
    const timer = setTimeout(() => {
      setSwitchingProvider(false);
      setToast("切换状态需要核实，正在读取电脑配置");
      void remoteSend({ type: "claude:status:get", requestId: requestId() }).catch(() => undefined);
    }, 40_000);
    return () => clearTimeout(timer);
  }, [switchingProvider, remoteSend]);

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
    const timer = setTimeout(() => { if (followLatestRef.current) messageEndRef.current?.scrollIntoView({ block: "end" }); }, 50);
    return () => clearTimeout(timer);
  }, [selectedKey, selectedMessageCount, selectedLiveMessageCount]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3_200);
    return () => clearTimeout(timer);
  }, [toast]);

  const sessionCount = useMemo(() => sessions.filter((session) => !session.currentWindow && session.provider === activeProvider).length, [sessions, activeProvider]);

  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = sessions
      .filter((session) => !session.currentWindow)
      .filter((session) => session.provider === activeProvider)
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
  const messages = selectedKey ? mergeSessionMessages(selectedDetail?.messages ?? [], liveMessages[selectedKey] ?? []) : [];
  const desktopSettings = activeProvider === "claude" ? claudeStatus?.defaultSettings : selectedDetail?.settings ?? codexStatus?.defaultSettings;
  const effectiveSettings: RunSettings = settingsCustomized ? settings : desktopSettings ?? { model: "", reasoning: "", permission: "workspace", serviceTier: "" };

  async function deliverEntry(entry: OutboxEntry) {
    const acknowledgement = new Promise<boolean>((resolve) => deliveryAcksRef.current.set(entry.requestId, () => resolve(true)));
    updateOutbox(entry.requestId, { status: "sending", error: undefined });
    try {
      let acknowledged = false;
      for (let deliveryAttempt = 0; deliveryAttempt < 3 && !acknowledged; deliveryAttempt += 1) {
        transportCountRef.current += 1;
        setSending(true);
        try { await remoteSend(entry.payload); }
        finally { transportCountRef.current -= 1; setSending(transportCountRef.current > 0); }
        if (outboxRef.current.get(entry.requestId)?.status === "sending") updateOutbox(entry.requestId, { status: "relayed" });
        acknowledged = await Promise.race([acknowledgement, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 12_000))]);
      }
      if (!acknowledged) {
        updateOutbox(entry.requestId, { status: "uncertain", error: "正在核实送达状态，请勿重复发送" });
        setRunning((value) => { const next = { ...value }; delete next[entry.sessionKey]; return next; });
        queryPendingRef.current?.();
      }
    } catch (error) {
      updateOutbox(entry.requestId, { status: "uncertain", error: error instanceof Error ? error.message : "连接暂时中断，消息已保留" });
      setRunning((value) => { const next = { ...value }; delete next[entry.sessionKey]; return next; });
      queryPendingRef.current?.();
    } finally { deliveryAcksRef.current.delete(entry.requestId); }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedSummary || !draft.trim() || sending) return;
    if (activeProvider === "claude" && selectedDetail?.terminalOpen) { setToast("请先退出电脑中的这个 Claude 会话，或在手机新建会话"); return; }
    if (activeProvider === "claude" && !claudeStatus?.canSend) { setToast("当前 Claude 版本暂不支持发送，请查看运行设置"); return; }
    if (settingsCustomized && (activeProvider === "claude" || !codexStatus?.desktopSettingsOnly) && settings.permission === "full" && !window.confirm("完全访问允许操作工作区之外的文件。继续发送？")) return;
    const prompt = draft.trim();
    const remoteRequestId = requestId();
    const remotePayload: RemotePayload = {
      type: "session:send",
      provider: selectedSummary.provider,
      sessionId: selectedSummary.id,
      prompt,
      ...(settingsCustomized ? { settings: effectiveSettings } : {}),
      execution: "desktop",
      requestId: remoteRequestId,
    };
    const entry: OutboxEntry = { requestId: remoteRequestId, sessionKey: selectedSummary.key, payload: remotePayload, createdAt: Date.now(), updatedAt: 0, status: "sending" };
    outboxRef.current.set(remoteRequestId, entry);
    try { writeOutbox(localStorage, pairing!.clientId, [...outboxRef.current.values()]); }
    catch { outboxRef.current.delete(remoteRequestId); setToast("浏览器无法保存待发送消息，请释放存储空间后重试"); return; }
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    waitingForReplyRef.current.set(selectedSummary.key, latestAssistant ? messageSignature(latestAssistant) : null);
    setSending(true);
    setRunning((value) => ({ ...value, [selectedSummary.key]: "sending" }));
    setDraft("");
    writeDraft(localStorage, pairing!.clientId, selectedSummary.key, "");
    followLatestRef.current = true;
    setLiveMessages((value) => ({
      ...value,
      [selectedSummary.key]: [...(value[selectedSummary.key] ?? []), outboxMessage(entry)],
    }));
    await deliverEntry(entry);
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

  function selectSession(session: SessionSummary) {
    setSelectedKey(session.key);
    setSettingsCustomized(false);
    followLatestRef.current = true;
    if (pairing) {
      setDraft(readDraft(localStorage, pairing.clientId, session.key));
      try { localStorage.setItem(`relaydesk.selected.${pairing.clientId}`, session.key); } catch { /* Optional restoration. */ }
    }
    if (session.provider === "codex" && !session.currentWindow) {
      void remoteSend({
        type: "session:activate",
        provider: session.provider,
        sessionId: session.id,
        requestId: requestId(),
      }).catch((error) => setToast(error instanceof Error ? error.message : "无法在电脑上打开这个会话"));
    }
  }

  function stopSession() {
    if (!selectedSummary) return;
    void remoteSend({ type: "session:stop", provider: selectedSummary.provider, sessionId: selectedSummary.id, requestId: requestId() })
      .then(() => setToast("正在停止"))
      .catch((error) => setToast(error instanceof Error ? error.message : "无法停止任务"));
  }

  function refreshWorkspace() {
    setSessionsLoading(true);
    setLoadingProgress(10);
    setLoadingLabel("正在同步 Codex");
    void remoteSend({ type: "sessions:list", requestId: requestId() }).catch((error) => {
      setSessionsLoading(false);
      setToast(error instanceof Error ? error.message : "同步失败");
    });
  }

  function refreshCodexStatus() {
    if (activeProvider === "claude") {
      void remoteSend({ type: "claude:status:get", requestId: requestId() }).catch(() => setToast("无法读取 Claude 状态"));
      return;
    }
    void remoteSend({ type: "codex:status:get", refresh: true, requestId: requestId() })
      .catch((error) => setToast(error instanceof Error ? error.message : "无法读取用量"));
  }

  const selectedModel = (activeProvider === "claude" ? claudeStatus?.models : codexStatus?.models)?.find((model) => model.model === effectiveSettings.model);

  if (!hydrated) return <main className="loading-shell"><SessionLoader progress={12} label="正在启动 RelayDesk" /></main>;
  if (!pairing) return <PairingScreen onPaired={setPairing} />;

  return (
    <main className={`app-shell ${selectedSummary ? "has-selection" : ""}`} data-provider={activeProvider}>
      <SessionBrowser
        sessionCount={sessionCount}
        device={visibleDevice}
        pairing={pairing}
        status={codexStatus}
        claudeStatus={claudeStatus}
        provider={activeProvider}
        onProviderChange={(provider) => { setBrowserProvider(provider); setSelectedKey(null); setSettingsCustomized(false); }}
        onNewClaude={() => {
          const cwd = window.prompt("Claude 项目在电脑上的绝对路径", selectedSummary?.cwd || sessions.find((session) => session.provider === "claude")?.cwd || "");
          if (!cwd?.trim()) return;
          void remoteSend({ type: "claude:create", cwd: cwd.trim(), requestId: requestId() }).catch((error) => setToast(error instanceof Error ? error.message : "无法新建 Claude 会话"));
        }}
        loading={sessionsLoading}
        loadingProgress={loadingProgress}
        loadingLabel={loadingLabel}
        currentWindow={activeProvider === "codex" ? currentWindow : undefined}
        selectedKey={selectedKey}
        query={query}
        projectGroups={projectGroups}
        collapsed={collapsed}
        running={running}
        onSelect={selectSession}
        onQueryChange={setQuery}
        onRefresh={refreshWorkspace}
        onOpenSettings={() => setSettingsOpen(true)}
        onForgetPhone={forgetPhone}
        setCollapsed={setCollapsed}
      />

      {selectedSummary ? (
        <ConversationView
          key={selectedSummary.key}
          session={selectedSummary}
          detail={selectedDetail}
          messages={messages}
          device={visibleDevice}
          runningStatus={running[selectedSummary.key]}
          draft={draft}
          settings={effectiveSettings}
          modelName={selectedModel?.displayName ?? effectiveSettings.model ?? "读取中"}
          connectionError={connectionError}
          supportsStop={activeProvider === "claude" ? Boolean(selectedSummary.active || running[selectedSummary.key]) : !codexStatus?.desktopSettingsOnly}
          managedSettings={settingsCustomized}
          sending={sending}
          messageEndRef={messageEndRef}
          onBack={() => setSelectedKey(null)}
          onDraftChange={(value) => { setDraft(value); if (pairing && selectedKey) writeDraft(localStorage, pairing.clientId, selectedKey, value); }}
          onFollowChange={(value) => { followLatestRef.current = value; }}
          onRetry={(id) => {
            const entry = outboxRef.current.get(id);
            if (!entry) return;
            if (["retryable", "failed"].includes(entry.status)) {
              const retry = { ...entry, payload: { ...entry.payload, retry: true, attemptId: requestId() } };
              updateOutbox(id, { payload: retry.payload });
              void deliverEntry(retry);
            }
            else queryPendingRef.current?.();
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onSubmit={submit}
          onKeyDown={keyDown}
          onStop={stopSession}
        />
      ) : <EmptyConversation provider={activeProvider} />}

      {settingsOpen && activeProvider === "claude" ? <ClaudeSettings
        status={claudeStatus} settings={effectiveSettings} customized={settingsCustomized} detail={selectedDetail} switching={switchingProvider}
        onChange={(value) => { setSettings(value); setSettingsCustomized(true); }} onClose={() => setSettingsOpen(false)}
        onRefresh={refreshCodexStatus} onFollow={() => setSettingsCustomized(false)}
        onSwitch={(id, name) => {
          if (!window.confirm(`将电脑上 Claude 的全局供应商切换为“${name}”？后续电脑和手机任务都会使用它。`)) return;
          setSwitchingProvider(true);
          void remoteSend({ type: "ccswitch:switch", providerId: id, requestId: requestId() }).catch(() => { setSwitchingProvider(false); setToast("切换请求尚未确认，请刷新状态核实"); });
        }}
      /> : settingsOpen ? <CodexSettings
        status={codexStatus}
        settings={effectiveSettings}
        error={statusError}
        currentWindow={Boolean(selectedSummary?.currentWindow)}
        customized={settingsCustomized}
        onChange={(value) => { setSettings(value); setSettingsCustomized(true); }}
        onClose={() => setSettingsOpen(false)}
        onRefresh={refreshCodexStatus}
        onUseDesktopSettings={() => setSettingsCustomized(false)}
      /> : null}

      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
