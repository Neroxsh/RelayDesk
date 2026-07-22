import { spawn } from "node:child_process";
import os from "node:os";
import { codexExecutable } from "./providers.mjs";

const CACHE_MS = 60_000;
let cache = { at: 0, value: null };

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
    for (const item of pending.values()) item.reject(error);
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

function publicWindow(window) {
  if (!window) return null;
  return {
    usedPercent: Number(window.usedPercent ?? 0),
    windowDurationMins: Number(window.windowDurationMins ?? 0),
    resetsAt: Number(window.resetsAt ?? 0),
  };
}

export async function getCodexStatus(force = false) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const client = createClient();
  try {
    await client.initialize();
    const [modelResponse, accountResponse, limitsResponse] = await Promise.all([
      client.request("model/list", { includeHidden: false, limit: 100 }),
      client.request("account/read", { refreshToken: false }),
      client.request("account/rateLimits/read", null),
    ]);
    const models = (modelResponse?.data ?? modelResponse?.models ?? [])
      .filter((model) => !model.hidden)
      .map(publicModel);
    const account = accountResponse?.account ?? null;
    const limits = limitsResponse?.rateLimits ?? limitsResponse ?? {};
    const value = {
      available: true,
      models,
      account: account ? {
        type: account.type ?? null,
        planType: account.planType ?? limits.planType ?? null,
      } : null,
      usage: {
        planType: limits.planType ?? account?.planType ?? null,
        primary: publicWindow(limits.primary),
        secondary: publicWindow(limits.secondary),
        credits: limits.credits ? {
          hasCredits: Boolean(limits.credits.hasCredits),
          unlimited: Boolean(limits.credits.unlimited),
          balance: limits.credits.balance ?? null,
        } : null,
      },
      platform: {
        os: process.platform,
        release: os.release(),
        arch: process.arch,
      },
      updatedAt: Date.now(),
    };
    cache = { at: Date.now(), value };
    return value;
  } finally {
    client.close();
  }
}

export function invalidateCodexStatus() {
  cache.at = 0;
}
