"use client";
import { X } from "lucide-react";
import type { ClaudeStatus, RunSettings, SessionDetail } from "../relaydesk-types";
import { ProviderIcon } from "./provider-icon";

export function ClaudeSettings({ status, settings, customized, detail, switching, onChange, onClose, onRefresh, onFollow, onSwitch, onPermission }: {
  status: ClaudeStatus | null; settings: RunSettings; customized: boolean; detail?: SessionDetail | null; switching: boolean;
  onChange: (value: RunSettings) => void; onClose: () => void; onRefresh: () => void; onFollow: () => void; onSwitch: (id: string, name: string) => void; onPermission: (permission: RunSettings["permission"]) => void;
}) {
  const models = [...(status?.models ?? [])];
  if (settings.model && !models.some((model) => model.model === settings.model)) models.unshift({ id: settings.model, model: settings.model, displayName: settings.model });
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-sheet" role="dialog" aria-modal="true" aria-label="Claude Code 设置">
      <header className="settings-header"><div><span className="settings-brand"><ProviderIcon provider="claude" size={18} />Claude Code · {status?.version || "检测中"}</span><h2>运行设置</h2></div><div className="settings-header-actions"><button onClick={onRefresh}>刷新状态</button><button onClick={onClose} aria-label="关闭"><X size={20} /></button></div></header>
      {!status?.canSend ? <p className="settings-notice">{status?.available ? "这个版本缺少所需命令行接口，请升级后发送。历史仍可查看。" : "未检测到可用的 Claude Code，请先在电脑安装并配置。"}</p> : null}
      <div className="settings-notice settings-source"><span>{detail?.terminalOpen ? "连接电脑原终端，沿用该终端的模型和思考设置。" : customized ? "以下设置将在下一条手机消息生效。" : "下一条消息跟随电脑当前 Claude 全局配置。"}</span>{customized ? <button onClick={onFollow}>跟随电脑</button> : null}</div>
      {detail?.settings?.model ? <p className="status-freshness">本会话上一轮实际模型：{detail.settings.model}</p> : null}
      <div className="settings-section"><label>模型</label><div className="model-options">{models.map((model) => <button key={model.id} disabled={detail?.terminalOpen} className={settings.model === model.model ? "active" : ""} onClick={() => onChange({ ...settings, model: model.model })}><span><strong>{model.displayName}</strong></span></button>)}</div></div>
      {status?.effort ? <div className="settings-section"><label>思考强度</label><div className="effort-options">{status.reasoningEfforts.map((effort) => <button key={effort} disabled={detail?.terminalOpen} className={settings.reasoning === effort ? "active" : ""} onClick={() => onChange({ ...settings, reasoning: effort })}>{effort}</button>)}</div></div> : <p className="settings-notice">此版本未提供思考强度参数，沿用 Claude 默认值。</p>}
      <div className="settings-section"><label>{detail?.control?.canSetPermissions ? "权限 · 立即应用到当前任务" : "权限"}</label><div className="effort-options">{([{ id: "read-only", name: "计划 / 只读" }, { id: "ask", name: "逐次询问" }, { id: "workspace", name: "允许编辑" }, { id: "full", name: "完全访问" }] as const).map((mode) => <button key={mode.id} disabled={detail?.terminalOpen && !detail.control?.canSetPermissions} className={settings.permission === mode.id ? "active" : ""} onClick={() => detail?.control?.canSetPermissions ? onPermission(mode.id) : onChange({ ...settings, permission: mode.id })}>{mode.name}</button>)}</div><p className="status-freshness">{detail?.terminalOpen ? "终端权限沿用电脑设置；手机可处理接入后的审批和问题。" : "逐次询问沿用 Claude 标准审批；允许编辑会自动批准文件编辑，额外权限仍在手机确认。"}</p></div>
      <div className="settings-section"><label>CC Switch · Claude 全局供应商</label><p className="settings-notice">{status?.ccSwitch.reason || "切换会同步修改电脑全局配置，影响后续 Claude 会话。已打开的终端可能需要重启。"}</p><div className="model-options">{status?.ccSwitch.providers.map((provider) => <button key={provider.id} className={provider.current ? "active" : ""} disabled={switching || provider.current || !status.ccSwitch.canSwitch} onClick={() => onSwitch(provider.id, provider.name)}><span><strong>{provider.name}{provider.current ? " · 当前" : ""}</strong></span></button>)}</div></div>
      <p className="status-freshness">供应商密钥保存在电脑。第三方余额与订阅剩余额度暂未读取。</p>
    </section>
  </div>;
}
