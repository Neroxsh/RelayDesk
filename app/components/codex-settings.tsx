"use client";

import { Check, ChevronRight, Gauge, LockKeyhole, Shield, Sparkles, X, Zap } from "lucide-react";
import type { CodexStatus, PermissionMode, RunSettings } from "../relaydesk-types";

type CodexSettingsProps = {
  status: CodexStatus | null;
  settings: RunSettings;
  currentWindow: boolean;
  customized: boolean;
  onChange: (settings: RunSettings) => void;
  onClose: () => void;
  onRefresh: () => void;
  onUseDesktopSettings: () => void;
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

export function CodexSettings({ status, settings, currentWindow, customized, onChange, onClose, onRefresh, onUseDesktopSettings }: CodexSettingsProps) {
  const models = status?.models ?? [];
  const selectedModel = models.find((model) => model.model === settings.model) ?? models.find((model) => model.isDefault) ?? models[0];
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const primary = status?.usage.primary;
  const remaining = Math.max(0, Math.round(100 - (primary?.usedPercent ?? 0)));
  const serviceTier = selectedModel?.serviceTiers?.[0];

  const updateModel = (model: typeof selectedModel) => {
    if (!model) return;
    onChange({
      ...settings,
      model: model.model,
      reasoning: model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.reasoningEffort ?? "",
      serviceTier: "",
    });
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-label="Codex 设置">
        <header className="settings-header">
          <div><span>Codex</span><h2>运行设置</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </header>

        {primary ? (
          <button className="usage-card" type="button" onClick={onRefresh}>
            <Gauge size={20} />
            <span><b>本期可用 {remaining}%</b><small>{resetText(primary.resetsAt)} · {status?.usage.planType?.toUpperCase()}</small></span>
            <i><em style={{ width: `${remaining}%` }} /></i>
            <ChevronRight size={16} />
          </button>
        ) : null}

        {currentWindow ? <p className="settings-notice">当前窗口沿用电脑端已选择的模型和权限；以下设置用于项目会话。</p> : (
          <div className="settings-notice settings-source">
            <span>{customized ? "自定义设置已启用，任务会由电脑后台继续。" : "当前沿用 Codex 电脑端的设置。"}</span>
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

        <div className="settings-section">
          <label>权限范围</label>
          <div className="permission-options">
            {PERMISSIONS.map((permission) => {
              const Icon = permission.icon;
              return (
                <button key={permission.id} type="button" className={`${settings.permission === permission.id ? "active" : ""} ${permission.id === "full" ? "danger" : ""}`} onClick={() => onChange({ ...settings, permission: permission.id })}>
                  <Icon size={18} /><span><strong>{permission.title}</strong><small>{permission.copy}</small></span>{settings.permission === permission.id ? <Check size={17} /> : null}
                </button>
              );
            })}
          </div>
        </div>

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
