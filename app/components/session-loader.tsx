"use client";

type SessionLoaderProps = {
  progress?: number;
  label?: string;
  compact?: boolean;
};

export function SessionLoader({ progress = 18, label = "正在连接 Codex", compact = false }: SessionLoaderProps) {
  const value = Math.max(4, Math.min(100, progress));
  return (
    <div className={`session-loader ${compact ? "compact" : ""}`} role="status" aria-live="polite">
      <div className="loader-orbit" aria-hidden="true"><i /><i /><b>C</b></div>
      <div className="loader-copy">
        <strong>{label}</strong>
        <span>{value < 35 ? "建立安全连接" : value < 80 ? "读取项目与会话" : "准备工作区"}</span>
      </div>
      <div className="loader-track" aria-hidden="true"><i style={{ width: `${value}%` }} /></div>
      <small>{value}%</small>
    </div>
  );
}
