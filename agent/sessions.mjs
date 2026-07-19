import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CODEX_ROOT = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "sessions")
  : path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const CODEX_INDEX = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "session_index.jsonl")
  : path.join(os.homedir(), ".codex", "session_index.jsonl");
const INITIAL_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_INCREMENT_BYTES = 4 * 1024 * 1024;
const RECENT_ROW_LIMIT = 1_500;

let cache = { at: 0, sessions: [] };
const transcriptCache = new Map();

async function walk(directory) {
  const files = [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(absolute)));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(absolute);
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
  }
  return files;
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
];

function sanitizeUserText(value) {
  let text = String(value ?? "");
  if (/^# Session title\b/i.test(text.trim())) return "";
  for (const tag of METADATA_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<${escaped}>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  text = text.replace(/# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  text = text.replace(/<image\s+name=[^>]+>/gi, "（图片）").replace(/<\/image>/gi, "");
  return text.trim();
}

function isMetadataOnly(value) {
  const text = sanitizeUserText(value);
  return !text || /^(?:<[^>]+>|# AGENTS\.md instructions|# Session title|<INSTRUCTIONS>)/i.test(text);
}

async function codexThreadNames() {
  const names = new Map();
  try {
    for (const row of parseLines(await readFile(CODEX_INDEX, "utf8"))) {
      if (row?.id && row?.thread_name) names.set(row.id, trimTitle(row.thread_name));
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
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

function claudeMeta(rows, filePath) {
  const first = rows.find((row) => row?.sessionId || row?.cwd) ?? {};
  const user = rows.find((row) => row?.type === "user" && !row?.isMeta && !isMetadataOnly(textFromContent(row.message?.content)));
  return {
    id: first.sessionId ?? uuidFromFilename(filePath),
    provider: "claude",
    title: trimTitle(sanitizeUserText(textFromContent(user?.message?.content))) || "Claude 会话",
    cwd: first.cwd ?? "",
    ...projectFields(first.cwd),
    filePath,
  };
}

export async function listSessions(force = false) {
  if (!force && Date.now() - cache.at < 2_000) return cache.sessions;
  const [codexFiles, claudeFiles, threadNames] = await Promise.all([walk(CODEX_ROOT), walk(CLAUDE_ROOT), codexThreadNames()]);
  const sessions = [];
  for (const [provider, files] of [
    ["codex", codexFiles],
    ["claude", claudeFiles],
  ]) {
    for (const filePath of files) {
      try {
        const info = await stat(filePath);
        const headRows = parseLines(await readHead(filePath));
        const session = provider === "codex" ? codexMeta(headRows, filePath, threadNames) : claudeMeta(headRows, filePath);
        sessions.push({
          ...session,
          key: `${provider}:${session.id}`,
          updatedAt: info.mtimeMs,
          recent: Date.now() - info.mtimeMs < 2 * 60_000,
        });
      } catch {
        // Skip a transient or malformed provider file.
      }
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  cache = { at: Date.now(), sessions };
  return sessions;
}

function pushMessage(messages, role, content, timestamp, meta) {
  const text = role === "user" ? sanitizeUserText(content) : String(content ?? "").trim();
  if (!text) return;
  const previous = messages.at(-1);
  if (previous?.role === role && previous.content === text) return;
  messages.push({
    id: `${timestamp ?? Date.now()}-${messages.length}`,
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
  for (const [index, row] of rows.entries()) {
    const timestamp = row?.timestamp ?? null;
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
    }
    if (row?.type === "response_item" && row.payload?.type === "message") {
      const role = row.payload.role === "assistant" ? "assistant" : row.payload.role === "user" ? "user" : null;
      if (role) pushMessage(responseMessages, role, textFromContent(row.payload.content), timestamp);
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
  const messages = eventMessages.length ? eventMessages : responseMessages;
  if (!sawTaskSignal) state = openCalls.size ? "working" : "idle";
  return { messages, activity: activity.slice(-40), state, hasTaskSignal: sawTaskSignal };
}

export function parseClaudeTranscript(rows) {
  const messages = [];
  const activity = [];
  for (const [index, row] of rows.entries()) {
    if ((row?.type === "user" || row?.type === "assistant") && !row?.isMeta) {
      pushMessage(messages, row.type, textFromContent(row.message?.content), row.timestamp ?? null);
      for (const item of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (item?.type === "tool_use") {
          activity.push(activityItem(row, index, `调用 ${item.name ?? "工具"}`));
        }
      }
    }
  }
  return { messages, activity: activity.slice(-40), state: "idle", hasTaskSignal: false };
}

function mergeMessages(previous, incoming) {
  const result = [...previous];
  const seen = new Set(previous.map((message) => `${message.role}\u0000${message.timestamp ?? ""}\u0000${message.content}`));
  for (const message of incoming) {
    const signature = `${message.role}\u0000${message.timestamp ?? ""}\u0000${message.content}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(message);
  }
  return result.slice(-120);
}

function parserFor(provider) {
  return provider === "codex" ? parseCodexTranscript : parseClaudeTranscript;
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
  const sessions = await listSessions(true);
  const session = sessions.find((item) => item.provider === provider && item.id === id);
  if (!session) throw new Error("会话不存在或已被移动");
  const transcript = await readSessionTranscript(provider, session.filePath);
  return {
    ...session,
    filePath: undefined,
    messages: transcript.messages.slice(-120),
    activity: transcript.activity,
    state: transcript.state,
  };
}

export function invalidateSessions() {
  cache.at = 0;
}
