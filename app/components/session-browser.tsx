"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  LoaderCircle,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  SquareTerminal,
} from "lucide-react";
import { formatWhen, providerName } from "../relaydesk-meta";
import type { ClaudeStatus, Provider, CodexStatus, DeviceStatus, ProjectGroup, SessionSummary, StoredPairing } from "../relaydesk-types";
import { SessionLoader } from "./session-loader";
import { ProviderIcon } from "./provider-icon";

type SessionBrowserProps = {
  sessionCount: number;
  device: DeviceStatus | null;
  pairing: StoredPairing;
  status: CodexStatus | null;
  claudeStatus: ClaudeStatus | null;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  onNewClaude: () => void;
  loading: boolean;
  loadingProgress: number;
  loadingLabel: string;
  currentWindow: SessionSummary | undefined;
  selectedKey: string | null;
  query: string;
  projectGroups: ProjectGroup[];
  collapsed: Record<string, boolean>;
  running: Record<string, string>;
  onSelect: (session: SessionSummary) => void;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onForgetPhone: () => void;
  setCollapsed: Dispatch<SetStateAction<Record<string, boolean>>>;
};

export function SessionBrowser({
  sessionCount,
  device,
  pairing,
  status,
  claudeStatus,
  provider,
  onProviderChange,
  onNewClaude,
  loading,
  loadingProgress,
  loadingLabel,
  currentWindow,
  selectedKey,
  query,
  projectGroups,
  collapsed,
  running,
  onSelect,
  onQueryChange,
  onRefresh,
  onOpenSettings,
  onForgetPhone,
  setCollapsed,
}: SessionBrowserProps) {
  const defaultModel = status?.models.find((model) => model.model === status.defaultSettings?.model);
  const used = status?.usage.primary?.usedPercent;
  return (
    <aside className="workspace-sidebar">
      <header className="sidebar-topbar">
        <div className="wordmark"><strong>RelayDesk</strong><span className={device?.online ? "online" : ""}>{device?.online ? "在线" : "电脑离线"}</span></div>
        <button className="icon-button" type="button" onClick={onForgetPhone} aria-label="连接管理" title="连接管理"><MoreHorizontal size={19} /></button>
      </header>

      <div className="assistant-tabs" aria-label="选择助手">{(["codex", "claude"] as const).map((item) => <button type="button" key={item} className={provider === item ? "active" : ""} onClick={() => onProviderChange(item)}><ProviderIcon provider={item} size={20} />{providerName(item)}</button>)}</div>

      <button className="codex-overview" type="button" onClick={onOpenSettings}>
        <ProviderIcon provider={provider} size={34} />
        <span><strong>{providerName(provider)}</strong><small>{provider === "claude" ? claudeStatus?.ccSwitch.providers.find((item) => item.current)?.name || claudeStatus?.version || "检测中" : defaultModel?.displayName ?? status?.defaultSettings?.model ?? "正在读取模型"} · {sessionCount} 个会话</small></span>
        {provider === "codex" ? typeof used === "number" ? <i title="短周期剩余额度">余 {Math.max(0, Math.round(100 - used))}%</i> : <i>读取中</i> : <i>设置</i>}
        <Settings2 size={17} />
      </button>

      <div className="computer-row">
        <Monitor size={18} strokeWidth={1.7} />
        <span><strong>{device?.name ?? pairing.device.name}</strong><small>{device?.online ? "已连接" : "等待电脑上线"}</small></span>
        <button className="icon-button" type="button" onClick={onRefresh} aria-label="同步会话" title="同步会话"><RefreshCw className={loading ? "spin" : ""} size={16} /></button>
      </div>

      {provider === "claude" ? <button className="current-task" type="button" disabled={!claudeStatus?.canSend || !claudeStatus.newSession} onClick={onNewClaude}><SquareTerminal size={20} /><span><strong>新建 Claude 会话</strong><small>{claudeStatus?.newSession ? "在电脑后台运行，手机继续操作" : "请先安装支持新建会话的 Claude 版本"}</small></span></button> : null}

      {currentWindow ? (
        <button className={`current-task ${selectedKey === currentWindow.key ? "selected" : ""}`} type="button" onClick={() => onSelect(currentWindow)}>
          <SquareTerminal size={20} strokeWidth={1.8} />
          <span><strong>继续上次会话</strong><small>{currentWindow.cwd || "Codex"}</small></span>
          <i>实时</i>
        </button>
      ) : null}

      <label className="session-search">
        <Search size={16} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索项目或会话" />
      </label>

      <div className="section-heading"><span>项目</span><small>{projectGroups.length}</small></div>
      <nav className="project-list" aria-label={`${providerName(provider)} 项目和会话`}>
        {loading && !projectGroups.length ? <SessionLoader compact progress={loadingProgress} label={loadingLabel} /> : null}
        {loading && projectGroups.length ? <div className="background-loading"><i style={{ width: `${loadingProgress}%` }} /></div> : null}
        {projectGroups.map((project) => {
          const collapseKey = `${provider}:${project.path}`;
          const isCollapsed = collapsed[collapseKey];
          return (
            <section className="project-group" key={collapseKey}>
              <button className="project-row" type="button" onClick={() => setCollapsed((value) => ({ ...value, [collapseKey]: !value[collapseKey] }))}>
                <Folder size={18} strokeWidth={1.7} />
                <span><strong>{project.name}</strong><small>{project.path || "未归类"}</small></span>
                <i>{project.sessions.length}</i>
                {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
              {!isCollapsed ? <div className="project-sessions">{project.sessions.map((session) => (
                <button className={`session-row ${selectedKey === session.key ? "selected" : ""}`} type="button" key={session.key} onClick={() => onSelect(session)}>
                  <MessageSquare size={15} strokeWidth={1.7} />
                  <span><strong>{session.title}</strong><small>{session.openInCodex ? "最近访问" : formatWhen(session.updatedAt)}</small></span>
                  {session.active || running[session.key] ? <LoaderCircle className="spin" size={15} /> : null}
                </button>
              ))}</div> : null}
            </section>
          );
        })}
        {!loading && !projectGroups.length ? <div className="empty-list"><Folder size={22} strokeWidth={1.4} /><p>{query ? "没有匹配的会话" : `还没有 ${providerName(provider)} 会话`}</p></div> : null}
      </nav>
    </aside>
  );
}
