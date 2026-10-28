import { spawn } from "node:child_process";
import os from "node:os";
import { codexExecutable } from "./providers.mjs";
import { getDesktopCapabilities } from "./desktop-bridge.mjs";
import { getSession, listSessions } from "./sessions.mjs";

const CACHE_MS = 60_000;
let cache = { at: 0, value: null };
let inFlight = null;

function createClient() {
  const executable = codexExecutable();
  const child = spawn(executable.command, [...executable.prefix, "app-server", "--stdio"], {
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let stderr = "";

  const failAll = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message ?? "Codex 服务返回错误"));
      else item.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
  });
  child.once("error", failAll);
  child.once("close", (code) => {
    if (pending.size) failAll(new Error(stderr.trim() || `Codex 服务已退出（${code ?? "unknown"}）`));
  });

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`读取 ${method} 超时`));
    }, 12_000);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, ...(params === undefined ? {} : { params }) });
  });

  return {
    async initialize() {
      await request("initialize", {
        clientInfo: { name: "relaydesk", title: "RelayDesk", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      write({ method: "initialized" });
    },
    request,
    close() {
      failAll(new Error("Codex 状态连接已关闭"));
      if (child.exitCode === null) child.kill();
    },
  };
}

function publicModel(model) {
  return {
    id: model.id ?? model.model,
    model: model.model ?? model.id,
    displayName: model.displayName ?? model.model ?? model.id,
    description: model.description ?? "",
    isDefault: Boolean(model.isDefault),
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((item) => typeof item === "string" ? { reasoningEffort: item, description: "" } : item)
      : [],
    serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers : [],
    defaultServiceTier: model.defaultServiceTier ?? null,
  };
}

export function publicWindow(window) {
  if (!window || window.usedPercent == null || !Number.isFinite(Number(window.usedPercent))) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Number(window.usedPercent))),
    windowDurationMins: Number(window.windowDurationMins ?? 0),
    resetsAt: Number(window.resetsAt ?? 0),
  };
}

export function normalizeUsage(response = {}, account = null) {
  const byId = response?.rateLimitsByLimitId ?? {};
  const limits = byId.codex ?? Object.values(byId).find(Boolean) ?? response?.rateLimits ?? response ?? {};
  return {
    planType: limits.planType ?? account?.planType ?? null,
    primary: publicWindow(limits.primary), secondary: publicWindow(limits.secondary),
    credits: limits.credits ? {
      hasCredits: Boolean(limits.credits.hasCredits), unlimited: Boolean(limits.credits.unlimited), balance: limits.credits.balance ?? null,
    } : null,
    buckets: Object.entries(byId).filter(([, bucket]) => bucket).map(([id, bucket]) => ({
      id, name: bucket.limitName ?? id, planType: bucket.planType ?? null,
      primary: publicWindow(bucket.primary), secondary: publicWindow(bucket.secondary),
    })),
    availableResetCount: response?.rateLimitResetCredits?.availableCount ?? null,
    activity: null,
  };
}

async function getCliCodexStatus() {
  const client = createClient();
  try {
    await client.initialize();
    const responses = await Promise.allSettled([
      client.request("model/list", { includeHidden: false, limit: 100 }),
      client.request("account/read", { refreshToken: false }),
      client.request("account/rateLimits/read", null),
      client.request("account/usage/read", null).catch(() => null),
      client.request("config/read", { includeLayers: false }).catch(() => null),
    ]);
    const [modelResponse, accountResponse, limitsResponse, usageResponse, configResponse] = responses.map((result) => result.status === "fulfilled" ? result.value : null);
    if (!modelResponse && !limitsResponse) throw new Error("暂时无法读取 Codex 状态");
    const models = (modelResponse?.data ?? modelResponse?.models ?? [])
      .filter((model) => !model.hidden)
      .map(publicModel);
    const account = accountResponse?.account ?? null;
    const usage = normalizeUsage(limitsResponse, account);
    const config = configResponse?.config ?? {};
    const value = {
      available: true,
      models,
      account: account ? {
        type: account.type ?? null,
        planType: account.planType ?? usage.planType ?? null,
      } : null,
      usage: {
        ...usage,
        activity: usageResponse?.summary ? {
          lifetimeTokens: Number(usageResponse.summary.lifetimeTokens ?? 0),
          peakDailyTokens: Number(usageResponse.summary.peakDailyTokens ?? 0),
          longestRunningTurnSec: Number(usageResponse.summary.longestRunningTurnSec ?? 0),
          currentStreakDays: Number(usageResponse.summary.currentStreakDays ?? 0),
          longestStreakDays: Number(usageResponse.summary.longestStreakDays ?? 0),
          daily: Array.isArray(usageResponse.dailyUsageBuckets)
            ? usageResponse.dailyUsageBuckets.slice(-14).map((item) => ({
                startDate: String(item.startDate ?? ""),
                tokens: Number(item.tokens ?? 0),
              }))
            : [],
        } : null,
      },
      platform: {
        os: process.platform,
        release: os.release(),
        arch: process.arch,
      },
      updatedAt: Date.now(),
      source: "cli",
      desktopSettingsOnly: process.platform === "win32",
      defaultSettings: {
        model: config.model ?? "", reasoning: config.model_reasoning_effort ?? "",
        permission: config.sandbox_mode === "danger-full-access" ? "full" : config.sandbox_mode === "read-only" ? "read-only" : "workspace",
        serviceTier: config.service_tier ?? "", source: "config",
      },
      warnings: responses.flatMap((result) => result.status === "rejected" ? [result.reason?.message ?? "部分状态暂不可用"] : []),
    };
    return value;
  } finally {
    client.close();
  }
}

async function getDesktopStatus() {
  const sessions = await listSessions();
  const sessionId = sessions.find((session) => session.id === process.env.CODEX_THREAD_ID)?.id ?? sessions[0]?.id;
  if (!sessionId) throw new Error("还没有可读取的 Codex 会话");
  const [desktop, session] = await Promise.all([getDesktopCapabilities(sessionId), getSession("codex", sessionId)]);
  const defaults = session.settings ?? null;
  const models = desktop.models.map((model) => ({ ...model, isDefault: model.model === defaults?.model }));
  if (defaults?.model && !models.some((model) => model.model === defaults.model)) models.unshift({
    id: defaults.model, model: defaults.model, displayName: defaults.model, description: "当前电脑会话使用的模型",
    isDefault: true, defaultReasoningEffort: defaults.reasoning,
    supportedReasoningEfforts: defaults.reasoning ? [{ reasoningEffort: defaults.reasoning }] : [], serviceTiers: [], defaultServiceTier: null,
  });
  const usage = normalizeUsage(desktop.limits);
  return {
    available: true, models, account: { type: "chatgpt", planType: usage.planType }, usage,
    defaultSettings: defaults, source: "desktop", desktopSettingsOnly: true,
    platform: { os: process.platform, release: os.release(), arch: process.arch },
    updatedAt: Date.now(), warnings: [], stale: false,
  };
}

export async function getCodexStatus(force = false) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      let value;
      if (process.platform === "win32") {
        try { value = await getDesktopStatus(); }
        catch (error) {
          if (cache.value) return { ...cache.value, stale: true, warnings: [error.message] };
          value = await getCliCodexStatus();
          value.warnings = [...value.warnings, "桌面状态暂不可用，当前显示 CLI 信息"];
        }
      } else value = await getCliCodexStatus();
      cache = { at: Date.now(), value };
      return value;
    } finally { inFlight = null; }
  })();
  return inFlight;
}

export function invalidateCodexStatus() {
  cache.at = 0;
}
