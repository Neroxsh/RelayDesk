"use client";

import { Check, ChevronRight, Gauge, LockKeyhole, Shield, Sparkles, X, Zap } from "lucide-react";
import type { CodexStatus, PermissionMode, RunSettings } from "../relaydesk-types";
import { ProviderIcon } from "./provider-icon";

type CodexSettingsProps = {
  status: CodexStatus | null;
  settings: RunSettings;
  currentWindow: boolean;
  customized: boolean;
  error?: string;
  onChange: (settings: RunSettings) => void;
  onClose: () => void;
  onRefresh: () => void;
  onUseDesktopSettings: () => void;
  canSetPermissions?: boolean;
  onPermission?: (permission: PermissionMode) => void;
};

const EFFORT_NAMES: Record<string, string> = {
  minimal: "极简",
  low: "快速",
  medium: "均衡",
  high: "深入",
  xhigh: "极深",
  max: "最大",
  ultra: "极致",
};

const PERMISSIONS: Array<{ id: PermissionMode; title: string; copy: string; icon: typeof Shield }> = [
  { id: "read-only", title: "只读", copy: "查看与分析，不修改文件", icon: LockKeyhole },
  { id: "workspace", title: "工作区", copy: "可修改当前项目文件", icon: Shield },
  { id: "full", title: "完全访问", copy: "允许访问工作区之外", icon: Zap },
];

function resetText(timestamp: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  return `重置于 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function CodexSettings({ status, settings, currentWindow, customized, error, onChange, onClose, onRefresh, onUseDesktopSettings, canSetPermissions, onPermission }: CodexSettingsProps) {
  const models = status?.models ?? [];
  const selectedModel = models.find((model) => model.model === settings.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const primary = status?.usage.primary;
  const secondary = status?.usage.secondary;
  const activity = status?.usage.activity;
  const today = activity?.daily.at(-1);
  const remaining = Math.max(0, Math.round(100 - (primary?.usedPercent ?? 0)));
  const serviceTier = selectedModel?.serviceTiers?.[0];

  const updateModel = (model: typeof selectedModel) => {
    if (!model) return;
    onChange({
      ...settings,
      model: model.model,
      reasoning: model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === settings.reasoning)
        ? settings.reasoning : model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.reasoningEffort ?? "",
      serviceTier: "",
    });
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-label="Codex 设置">
        <header className="settings-header">
          <div><span className="settings-brand"><ProviderIcon provider="codex" size={18} />Codex</span><h2>运行设置</h2></div>
          <div className="settings-header-actions"><button type="button" onClick={onRefresh}>刷新状态</button><button type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
        </header>

        {primary ? (
          <button className="usage-card" type="button" onClick={onRefresh}>
            <Gauge size={20} />
            <span><b>{primary.windowDurationMins ? `${primary.windowDurationMins / 60} 小时` : "短周期"}可用 {remaining}%</b><small>{resetText(primary.resetsAt)} · {status?.usage.planType?.toUpperCase()}</small></span>
            <i><em style={{ width: `${remaining}%` }} /></i>
            <ChevronRight size={16} />
          </button>
        ) : <button className="usage-unavailable" type="button" onClick={onRefresh}>用量暂不可用 · 点击重新读取</button>}
        {secondary ? <button className="usage-card secondary-usage" type="button" onClick={onRefresh}>
          <Gauge size={20} /><span><b>{secondary.windowDurationMins >= 10080 ? "本周" : "长周期"}可用 {Math.round(100 - secondary.usedPercent)}%</b><small>{resetText(secondary.resetsAt)}</small></span>
          <i><em style={{ width: `${Math.round(100 - secondary.usedPercent)}%` }} /></i><ChevronRight size={16} />
        </button> : null}
        <p className="status-freshness">{status?.stale ? "当前为上次成功同步的数据" : status?.updatedAt ? `同步于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(status.updatedAt)}` : "正在读取电脑状态"}{error ? ` · ${error}` : ""}</p>

        {activity ? (
          <div className="usage-summary" aria-label="Codex 使用统计">
            <span><small>今日</small><strong>{today ? compactNumber(today.tokens) : "0"}</strong><i>tokens</i></span>
            <span><small>累计</small><strong>{compactNumber(activity.lifetimeTokens)}</strong><i>tokens</i></span>
            <span><small>连续使用</small><strong>{activity.currentStreakDays}</strong><i>天</i></span>
          </div>
        ) : null}

        {status?.desktopSettingsOnly || currentWindow ? <div className="settings-notice settings-source"><span>{customized ? "模型和思考强度将在下一条消息生效，仍继续电脑上的原会话。" : "模型和思考强度来自当前电脑会话；可在这里调整下一条消息。"} 权限沿用电脑。</span>{customized ? <button type="button" onClick={onUseDesktopSettings}>跟随电脑</button> : null}</div> : (
          <div className="settings-notice settings-source">
            <span>{customized ? "自定义设置将在下一条消息生效。" : "当前沿用 Codex 电脑端的设置。"}</span>
            {customized ? <button type="button" onClick={onUseDesktopSettings}>改回电脑端</button> : null}
          </div>
        )}

        <div className="settings-section">
          <label>模型</label>
          <div className="model-options">
            {models.map((model) => (
              <button key={model.id} type="button" className={selectedModel?.id === model.id ? "active" : ""} onClick={() => updateModel(model)}>
                <span><strong>{model.displayName}</strong><small>{model.description}</small></span>
                {selectedModel?.id === model.id ? <Check size={17} /> : null}
              </button>
            ))}
            {!models.length ? <div className="settings-unavailable">电脑上线后会自动读取可用模型。</div> : null}
          </div>
        </div>

        {efforts.length ? (
          <div className="settings-section">
            <label>思考强度</label>
            <div className="effort-options">
              {efforts.map((effort) => (
                <button key={effort.reasoningEffort} type="button" className={settings.reasoning === effort.reasoningEffort ? "active" : ""} onClick={() => onChange({ ...settings, reasoning: effort.reasoningEffort })}>
                  {EFFORT_NAMES[effort.reasoningEffort] ?? effort.reasoningEffort}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {!status?.desktopSettingsOnly || canSetPermissions ? <div className="settings-section">
          <label>权限范围</label>
          <div className="permission-options">
            {PERMISSIONS.map((permission) => {
              const Icon = permission.icon;
              return (
                <button key={permission.id} type="button" className={`${settings.permission === permission.id ? "active" : ""} ${permission.id === "full" ? "danger" : ""}`} onClick={() => canSetPermissions ? onPermission?.(permission.id) : onChange({ ...settings, permission: permission.id })}>
                  <Icon size={18} /><span><strong>{permission.title}</strong><small>{permission.copy}</small></span>{settings.permission === permission.id ? <Check size={17} /> : null}
                </button>
              );
            })}
          </div>
        </div> : <p className="settings-notice">当前电脑权限：{settings.permission === "full" ? "完全访问" : settings.permission === "read-only" ? "只读" : "工作区"}。调整权限请在电脑端操作。</p>}

        {serviceTier ? (
          <div className="settings-section">
            <label>响应速度</label>
            <button className={`fast-toggle ${settings.serviceTier === serviceTier.id ? "active" : ""}`} type="button" onClick={() => onChange({ ...settings, serviceTier: settings.serviceTier === serviceTier.id ? "" : serviceTier.id })}>
              <Sparkles size={18} /><span><strong>{serviceTier.name}</strong><small>{serviceTier.description}</small></span><i />
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
