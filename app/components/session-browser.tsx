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
  SquareTerminal,
} from "lucide-react";
import { formatWhen, PROVIDERS, providerName } from "../relaydesk-meta";
import type { DeviceStatus, ProjectGroup, Provider, SessionSummary, StoredPairing } from "../relaydesk-types";

type SessionBrowserProps = {
  activeProvider: Provider;
  providerCounts: Record<Provider, number>;
  device: DeviceStatus | null;
  pairing: StoredPairing;
  currentWindow: SessionSummary | undefined;
  selectedKey: string | null;
  query: string;
  projectGroups: ProjectGroup[];
  collapsed: Record<string, boolean>;
  running: Record<string, string>;
  onProviderChange: (provider: Provider) => void;
  onSelect: (session: SessionSummary) => void;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  onForgetPhone: () => void;
  setCollapsed: Dispatch<SetStateAction<Record<string, boolean>>>;
};

export function SessionBrowser({
  activeProvider,
  providerCounts,
  device,
  pairing,
  currentWindow,
  selectedKey,
  query,
  projectGroups,
  collapsed,
  running,
  onProviderChange,
  onSelect,
  onQueryChange,
  onRefresh,
  onForgetPhone,
  setCollapsed,
}: SessionBrowserProps) {
  return (
    <aside className="workspace-sidebar">
      <header className="sidebar-topbar">
        <div className="wordmark"><strong>RelayDesk</strong><span className={device?.online ? "online" : ""}>{device?.online ? "在线" : "电脑离线"}</span></div>
        <button className="icon-button" type="button" onClick={onForgetPhone} aria-label="移除此手机" title="移除此手机"><MoreHorizontal size={19} /></button>
      </header>

      <nav className="provider-tabs" aria-label="选择工具">
        {(["codex", "claude"] as Provider[]).map((provider) => (
          <button type="button" key={provider} className={activeProvider === provider ? "active" : ""} onClick={() => onProviderChange(provider)} aria-pressed={activeProvider === provider}>
            <span className={`provider-dot ${provider}`} />
            <strong>{providerName(provider)}</strong>
            <small>{providerCounts[provider]}</small>
          </button>
        ))}
      </nav>

      <div className="computer-row">
        <Monitor size={18} strokeWidth={1.7} />
        <span><strong>{device?.name ?? pairing.device.name}</strong><small>{device?.online ? "已连接" : "等待电脑上线"}</small></span>
        <button className="icon-button" type="button" onClick={onRefresh} aria-label="同步会话" title="同步会话"><RefreshCw size={16} /></button>
      </div>

      {activeProvider === "codex" && currentWindow ? (
        <button className={`current-task ${selectedKey === currentWindow.key ? "selected" : ""}`} type="button" onClick={() => onSelect(currentWindow)}>
          <SquareTerminal size={20} strokeWidth={1.8} />
          <span><strong>电脑上的当前任务</strong><small>{currentWindow.cwd || "Codex"}</small></span>
          <i>实时</i>
        </button>
      ) : null}

      <label className="session-search">
        <Search size={16} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={`搜索 ${providerName(activeProvider)} 会话`} />
      </label>

      <div className="section-heading"><span>项目</span><small>{projectGroups.length}</small></div>
      <nav className="project-list" aria-label={`${providerName(activeProvider)} 项目和会话`}>
        {projectGroups.map((project) => {
          const collapseKey = `${activeProvider}:${project.path}`;
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
                  <span><strong>{session.title}</strong><small>{session.openInCodex ? "正在电脑上打开" : formatWhen(session.updatedAt)}</small></span>
                  {session.active || running[session.key] ? <LoaderCircle className="spin" size={15} /> : null}
                </button>
              ))}</div> : null}
            </section>
          );
        })}
        {!projectGroups.length ? <div className="empty-list"><Folder size={22} strokeWidth={1.4} /><p>{query ? "没有匹配的会话" : `还没有 ${PROVIDERS[activeProvider].name} 会话`}</p></div> : null}
      </nav>
    </aside>
  );
}
