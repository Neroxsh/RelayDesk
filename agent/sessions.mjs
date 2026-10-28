import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mergeTimelineMessages } from "./messages.mjs";
import { claudeHome, configureClaudeHome, parseClaudeTranscript, pendingClaudeSessions, activeClaudeSessions } from "./claude-sessions.mjs";

const INITIAL_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_INCREMENT_BYTES = 4 * 1024 * 1024;
const RECENT_ROW_LIMIT = 1_500;

let cache = { at: 0, sessions: [] };
const transcriptCache = new Map();
let configuredHome = "";

function uniquePaths(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value) return false;
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanPath(value) {
  const text = String(value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  return text ? path.resolve(text) : "";
}

export function normalizeProviderHome(provider, value) {
  let resolved = cleanPath(value);
  if (!resolved) return "";
  const leaf = path.basename(resolved).toLowerCase();
  if (!["codex", "claude"].includes(provider)) return "";
  if (provider === "claude" && leaf === "projects") resolved = path.dirname(resolved);
  if (leaf === "sessions") resolved = path.dirname(resolved);
  if (leaf === "session_index.jsonl") resolved = path.dirname(resolved);
  return resolved;
}

export function configureSessionRoots({ codexHome = "", claudeHome: customClaudeHome = "" } = {}) {
  configuredHome = normalizeProviderHome("codex", codexHome);
  configureClaudeHome(normalizeProviderHome("claude", customClaudeHome));
  invalidateSessions();
}

function providerHomes(provider = "codex") {
  const home = os.homedir();
  if (provider === "claude") return [claudeHome()];
  if (provider !== "codex") return [];
  return uniquePaths([
    configuredHome,
    normalizeProviderHome("codex", process.env.CODEX_HOME),
    path.join(home, ".codex"),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex") : "",
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "codex") : "",
    process.env.APPDATA ? path.join(process.env.APPDATA, "Codex") : "",
  ].map((value) => normalizeProviderHome("codex", value)));
}

function providerRoots(provider) {
  return providerHomes(provider).map((home) => ({ home, root: path.join(home, provider === "claude" ? "projects" : "sessions") }));
}

async function walk(directory) {
  const files = [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(absolute);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return [absolute];
      return [];
    }));
    files.push(...nested.flat());
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
  }
  return files;
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readSlice(filePath, start, length) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readHead(filePath, bytes = 256 * 1024) {
  const info = await stat(filePath);
  return readSlice(filePath, 0, Math.min(bytes, info.size));
}

async function readTail(filePath, bytes = INITIAL_HISTORY_BYTES) {
  const info = await stat(filePath);
  const length = Math.min(bytes, info.size);
  const text = await readSlice(filePath, info.size - length, length);
  if (length === info.size) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
}

function completeLines(text) {
  const lastBreak = text.lastIndexOf("\n");
  if (lastBreak < 0) return { complete: "", carry: text };
  return { complete: text.slice(0, lastBreak + 1), carry: text.slice(lastBreak + 1) };
}

function parseLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A file can be read while the provider is appending its last line.
    }
  }
  return rows;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (item.type === "tool_use") return `调用工具：${item.name ?? "tool"}`;
      if (item.type === "tool_result") {
        const value = textFromContent(item.content);
        return value ? `工具结果：${value}` : "工具已完成";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function trimTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

const METADATA_TAGS = [
  "recommended_plugins",
  "environment_context",
  "permissions instructions",
  "app-context",
  "skills_instructions",
  "apps_instructions",
  "plugins_instructions",
  "collaboration_mode",
  "external_codex_apps_open_page",
  "in-app-browser-context",
  "send_user_message_question_reply",
];

function sanitizeUserText(value) {
  let text = String(value ?? "");
  const forwarded = text.match(/<codex_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*?<\/codex_delegation>/i);
  if (forwarded) text = forwarded[1];
  if (/^# Session title\b/i.test(text.trim())) return "";
  for (const tag of METADATA_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<${escaped}>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  text = text.replace(/# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  text = text.replace(/<image\s+name=[^>]+>/gi, "（图片）").replace(/<\/image>/gi, "");
  return text.trim();
}

async function codexThreadNames(homes = providerHomes("codex")) {
  const names = new Map();
  for (const home of homes) {
    try {
      for (const row of parseLines(await readFile(path.join(home, "session_index.jsonl"), "utf8"))) {
        if (row?.id && row?.thread_name) names.set(row.id, trimTitle(row.thread_name));
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  return names;
}

function projectFields(cwd) {
  const projectPath = String(cwd ?? "");
  return {
    projectPath,
    projectName: projectPath ? path.basename(path.normalize(projectPath)) || projectPath : "未归类",
  };
}

function uuidFromFilename(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match?.[1] ?? path.basename(filePath, ".jsonl");
}

function codexMeta(rows, filePath, threadNames) {
  const meta = rows.find((row) => row?.type === "session_meta")?.payload ?? {};
  const id = meta.id ?? meta.session_id ?? uuidFromFilename(filePath);
  let title = threadNames.get(id) ?? "";
  for (const row of rows) {
    if (title) break;
    if (row?.type === "event_msg" && row.payload?.type === "user_message") {
      title = trimTitle(sanitizeUserText(row.payload.message));
      if (title) break;
    }
    if (row?.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      title = trimTitle(sanitizeUserText(textFromContent(row.payload.content)));
      if (title) break;
    }
  }
  return {
    id,
    provider: "codex",
    title: title || "Codex 会话",
    cwd: meta.cwd ?? "",
    ...projectFields(meta.cwd),
    filePath,
  };
}

export async function listSessions(force = false) {
  if (!force && Date.now() - cache.at < 2_000) return cache.sessions;
  const codexLocations = providerRoots("codex");
  const [codexGroups, threadNames] = await Promise.all([
    Promise.all(codexLocations.map(({ root }) => walk(root))),
    codexThreadNames(codexLocations.map(({ home }) => home)),
  ]);
  const codexFiles = uniquePaths(codexGroups.flat());
  const records = await mapConcurrent(codexFiles, 16, async (filePath) => {
    try {
      const info = await stat(filePath);
      const headRows = parseLines(await readHead(filePath));
      const session = codexMeta(headRows, filePath, threadNames);
      return {
        ...session,
        key: `codex:${session.id}`,
        updatedAt: info.mtimeMs,
        recent: Date.now() - info.mtimeMs < 2 * 60_000,
      };
    } catch {
      return null;
    }
  });
  const claudeFiles = (await walk(path.join(claudeHome(), "projects")).catch(() => [])).filter((file) => !file.includes(`${path.sep}subagents${path.sep}`));
  const claudeRecords = await mapConcurrent(claudeFiles, 8, async (filePath) => {
    try {
      const info = await stat(filePath);
      const rows = parseLines(await readHead(filePath));
      const meta = rows.find((row) => row.sessionId && row.cwd && !row.isSidechain);
      if (!meta) return null;
      const text = rows.find((row) => row.type === "user" && !row.isMeta && typeof row.message?.content === "string")?.message.content;
      const titleRow = rows.findLast((row) => row.type === "custom-title");
      return { id: meta.sessionId, key: `claude:${meta.sessionId}`, provider: "claude", title: trimTitle(titleRow?.customTitle ?? text) || "Claude Code 会话", cwd: meta.cwd, ...projectFields(meta.cwd), filePath, updatedAt: info.mtimeMs, recent: Date.now() - info.mtimeMs < 120_000 };
    } catch { return null; }
  });
  const sessions = [];
  const sessionKeys = new Set();
  for (const session of [...records, ...claudeRecords, ...await pendingClaudeSessions()]) {
    if (!session || sessionKeys.has(session.key)) continue;
    sessionKeys.add(session.key);
    sessions.push(session);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  cache = { at: Date.now(), sessions };
  return sessions;
}

export async function sessionDiagnostics() {
  const parsedSessions = await listSessions();
  const inspect = async (provider) => {
    const locations = providerRoots(provider);
    const groups = await Promise.all(locations.map(({ root }) => walk(root)));
    const counts = locations.map(({ home, root }, index) => ({ home, root, count: groups[index].length }));
    const active = counts.find((item) => item.count > 0) ?? counts[0] ?? { home: "", root: "", count: 0 };
    const fileCount = uniquePaths(groups.flat()).length;
    const count = parsedSessions.filter((session) => session.provider === provider).length;
    return {
      configuredHome: provider === "codex" ? configuredHome : "",
      activeHome: active.home,
      activeRoot: active.root,
      count,
      fileCount,
      skippedCount: Math.max(0, fileCount - count),
      searched: counts.map(({ home, root, count }) => ({ home, root, count })),
    };
  };
  return { codex: await inspect("codex"), claude: await inspect("claude").catch(() => ({ count: 0, fileCount: 0, searched: [], error: "Claude 会话目录不可读" })) };
}

function pushMessage(messages, role, content, timestamp, meta) {
  const text = role === "user" ? sanitizeUserText(content) : String(content ?? "").trim();
  if (!text) return;
  const previous = messages.at(-1);
  if (previous?.role === role && previous.content === text && previous.timestamp === timestamp) return;
  messages.push({
    id: `${timestamp ?? "unknown"}-${role}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    role,
    content: text.slice(0, 120_000),
    timestamp: timestamp ?? null,
    ...(meta ? { meta } : {}),
  });
}

function toolLabel(name, running) {
  const labels = {
    exec: ["正在运行本机操作", "本机操作已完成"],
    wait: ["正在等待后台任务", "后台任务已返回"],
    apply_patch: ["正在更新文件", "文件已更新"],
    browser: ["正在操作网页", "网页操作已完成"],
  };
  const pair = labels[String(name ?? "").toLowerCase()] ?? ["正在执行操作", "操作已完成"];
  return pair[running ? 0 : 1];
}

function activityItem(row, index, label, status = "completed", detail = "") {
  return {
    id: `${row?.timestamp ?? "activity"}-${index}`,
    label,
    detail,
    status,
    timestamp: row?.timestamp ?? null,
  };
}

export function parseCodexTranscript(rows) {
  const eventMessages = [];
  const responseMessages = [];
  const activity = [];
  const calls = new Map();
  const openCalls = new Set();
  let state = "idle";
  let sawTaskSignal = false;
  let settings;
  for (const [index, row] of rows.entries()) {
    const timestamp = row?.timestamp ?? null;
    if (row?.type === "turn_context" && row.payload?.model) {
      const context = row.payload;
      const sandbox = context.sandbox_policy?.type;
      settings = {
        model: context.model,
        reasoning: context.effort ?? context.reasoning_effort ?? "",
        permission: sandbox === "danger-full-access" ? "full" : sandbox === "read-only" ? "read-only" : "workspace",
        serviceTier: context.service_tier ?? "",
        source: "session",
      };
    }
    if (row?.type === "event_msg") {
      if (row.payload?.type === "user_message") pushMessage(eventMessages, "user", row.payload.message, timestamp);
      if (row.payload?.type === "agent_message") pushMessage(eventMessages, "assistant", row.payload.message, timestamp);
      if (row.payload?.type === "task_started") {
        sawTaskSignal = true;
        state = "working";
        activity.push(activityItem(row, index, "开始处理", "running"));
      }
      if (row.payload?.type === "patch_apply_end") {
        const count = Array.isArray(row.payload.changes) ? row.payload.changes.length : 0;
        activity.push(activityItem(row, index, count ? `已更新 ${count} 个文件` : "文件已更新"));
      }
      if (row.payload?.type === "task_complete") {
        sawTaskSignal = true;
        state = "idle";
        const duration = Number(row.payload.duration_ms ?? 0);
        const detail = duration > 0 ? `${Math.max(1, Math.round(duration / 1000))} 秒` : "";
        activity.push(activityItem(row, index, "任务完成", "completed", detail));
      }
      if (["turn_aborted", "task_failed", "task_interrupted"].includes(row.payload?.type)) {
        sawTaskSignal = true;
        state = "idle";
        activity.push(activityItem(row, index, row.payload.type === "task_failed" ? "任务失败" : "任务已停止", "failed"));
      }
    }
    if (row?.type === "response_item" && row.payload?.type === "message") {
      const role = row.payload.role === "assistant" ? "assistant" : row.payload.role === "user" ? "user" : null;
      if (role) pushMessage(responseMessages, role, textFromContent(row.payload.content), timestamp);
    }
    if (row?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(row.payload?.type)
      && typeof row.payload.output === "string" && /^\s*<codex_delegation>/.test(row.payload.output)
      && /<\/codex_delegation>\s*$/.test(row.payload.output)) {
      pushMessage(responseMessages, "user", row.payload.output, timestamp);
    }
    if (row?.type === "response_item" && ["function_call", "custom_tool_call"].includes(row.payload?.type)) {
      const callId = row.payload.call_id ?? row.payload.id ?? `${index}`;
      const item = activityItem(row, index, toolLabel(row.payload.name, true), "running");
      calls.set(callId, { position: activity.length, name: row.payload.name });
      openCalls.add(callId);
      activity.push(item);
    }
    if (row?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(row.payload?.type)) {
      const call = calls.get(row.payload.call_id);
      if (call && activity[call.position]) {
        activity[call.position] = {
          ...activity[call.position],
          label: toolLabel(call.name, false),
          status: "completed",
        };
      }
      openCalls.delete(row.payload.call_id);
    }
  }
  // Forwarded desktop messages can exist only in response_item. Keeping just
  // event_msg loses those user turns and leaves the local echo below the reply.
  const matchedEvents = new Set();
  const unmatchedResponses = responseMessages.filter((message) => {
    const match = eventMessages.findIndex((event, index) => !matchedEvents.has(index)
      && event.role === message.role && event.content === message.content
      && Math.abs(Date.parse(event.timestamp ?? "") - Date.parse(message.timestamp ?? "")) < 2_000);
    if (match < 0) return true;
    matchedEvents.add(match);
    return false;
  });
  const messages = mergeTimelineMessages(unmatchedResponses, eventMessages);
  if (!sawTaskSignal) state = openCalls.size ? "working" : "idle";
  return { messages, activity: activity.slice(-40), state, hasTaskSignal: sawTaskSignal, settings };
}

function mergeMessages(previous, incoming) {
  return mergeTimelineMessages(previous, incoming, 240);
}

function parserFor(provider) {
  return provider === "claude" ? parseClaudeTranscript : parseCodexTranscript;
}

function enoughContext(transcript, fileSize, bytes) {
  if (bytes >= fileSize || bytes >= MAX_HISTORY_BYTES) return true;
  const users = transcript.messages.filter((message) => message.role === "user").length;
  return users >= 1 && transcript.messages.length >= 8;
}

async function initialTranscript(provider, filePath, info) {
  const parse = parserFor(provider);
  let bytes = Math.min(INITIAL_HISTORY_BYTES, info.size);
  let rows = [];
  let transcript = parse(rows);
  let carry = "";
  while (true) {
    const lines = completeLines(await readTail(filePath, bytes));
    rows = parseLines(lines.complete);
    transcript = parse(rows);
    carry = lines.carry;
    if (enoughContext(transcript, info.size, bytes)) break;
    bytes = Math.min(info.size, MAX_HISTORY_BYTES, bytes * 2);
  }
  return {
    size: info.size,
    carry,
    recentRows: rows.slice(-RECENT_ROW_LIMIT),
    transcript: { ...transcript, messages: transcript.messages.slice(-120) },
  };
}

async function cachedTranscript(provider, filePath) {
  const info = await stat(filePath);
  const previous = transcriptCache.get(filePath);
  if (previous?.size === info.size) return previous.transcript;

  if (previous && info.size > previous.size && info.size - previous.size <= MAX_INCREMENT_BYTES) {
    const appended = previous.carry + await readSlice(filePath, previous.size, info.size - previous.size);
    const lines = completeLines(appended);
    const newRows = parseLines(lines.complete);
    const recentRows = [...previous.recentRows, ...newRows].slice(-RECENT_ROW_LIMIT);
    const recent = parserFor(provider)(recentRows);
    const transcript = {
      ...recent,
      settings: recent.settings ?? previous.transcript.settings,
      messages: mergeMessages(previous.transcript.messages, recent.messages),
      activity: recent.activity.length ? recent.activity : previous.transcript.activity,
      state: recent.hasTaskSignal || recent.state === "working" ? recent.state : previous.transcript.state,
    };
    transcriptCache.set(filePath, { size: info.size, carry: lines.carry, recentRows, transcript });
    return transcript;
  }

  const initial = await initialTranscript(provider, filePath, info);
  transcriptCache.set(filePath, initial);
  return initial.transcript;
}

export async function readSessionTranscript(provider, filePath) {
  if (!["codex", "claude"].includes(provider)) throw new Error("不支持的会话类型");
  return cachedTranscript(provider, filePath);
}

export async function getSession(provider, id) {
  let sessions = await listSessions();
  let session = sessions.find((item) => item.provider === provider && item.id === id);
  if (!session) {
    sessions = await listSessions(true);
    session = sessions.find((item) => item.provider === provider && item.id === id);
  }
  if (!session) throw new Error("会话不存在或已被移动");
  const transcript = session.filePath ? await readSessionTranscript(provider, session.filePath) : { messages: [], activity: [], state: "idle" };
  const activeClaude = provider === "claude" ? (await activeClaudeSessions()).find((row) => row.sessionId === id) : null;
  return {
    ...session,
    filePath: undefined,
    messages: transcript.messages.slice(-120),
    activity: transcript.activity,
    state: activeClaude?.status === "busy" ? "working" : transcript.state,
    terminalOpen: Boolean(activeClaude && activeClaude.kind !== "background" && activeClaude.kind !== "sdk" && activeClaude.entrypoint !== "sdk-cli"),
    settings: transcript.settings,
  };
}

export function invalidateSessions() {
  cache.at = 0;
}
