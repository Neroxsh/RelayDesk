import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CODEX_ROOT = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "sessions")
  : path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
const MAX_HISTORY_BYTES = 3 * 1024 * 1024;

let cache = { at: 0, sessions: [] };

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

async function readTail(filePath, bytes = MAX_HISTORY_BYTES) {
  const info = await stat(filePath);
  const length = Math.min(bytes, info.size);
  const text = await readSlice(filePath, info.size - length, length);
  if (length === info.size) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
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

function uuidFromFilename(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match?.[1] ?? path.basename(filePath, ".jsonl");
}

function codexMeta(rows, filePath) {
  const meta = rows.find((row) => row?.type === "session_meta")?.payload ?? {};
  let title = "";
  for (const row of rows) {
    if (row?.type === "event_msg" && row.payload?.type === "user_message") {
      title = trimTitle(row.payload.message);
      if (title) break;
    }
    if (row?.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      title = trimTitle(textFromContent(row.payload.content));
      if (title) break;
    }
  }
  return {
    id: meta.id ?? meta.session_id ?? uuidFromFilename(filePath),
    provider: "codex",
    title: title || "Codex 会话",
    cwd: meta.cwd ?? "",
    filePath,
  };
}

function claudeMeta(rows, filePath) {
  const first = rows.find((row) => row?.sessionId || row?.cwd) ?? {};
  const user = rows.find((row) => row?.type === "user" && !row?.isMeta);
  return {
    id: first.sessionId ?? uuidFromFilename(filePath),
    provider: "claude",
    title: trimTitle(textFromContent(user?.message?.content)) || "Claude 会话",
    cwd: first.cwd ?? "",
    filePath,
  };
}

export async function listSessions(force = false) {
  if (!force && Date.now() - cache.at < 2_000) return cache.sessions;
  const [codexFiles, claudeFiles] = await Promise.all([walk(CODEX_ROOT), walk(CLAUDE_ROOT)]);
  const sessions = [];
  for (const [provider, files] of [
    ["codex", codexFiles],
    ["claude", claudeFiles],
  ]) {
    for (const filePath of files) {
      try {
        const info = await stat(filePath);
        const headRows = parseLines(await readHead(filePath));
        const session = provider === "codex" ? codexMeta(headRows, filePath) : claudeMeta(headRows, filePath);
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
  const text = String(content ?? "").trim();
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

function codexMessages(rows) {
  const eventMessages = [];
  const responseMessages = [];
  for (const row of rows) {
    const timestamp = row?.timestamp ?? null;
    if (row?.type === "event_msg") {
      if (row.payload?.type === "user_message") pushMessage(eventMessages, "user", row.payload.message, timestamp);
      if (row.payload?.type === "agent_message") pushMessage(eventMessages, "assistant", row.payload.message, timestamp);
    }
    if (row?.type === "response_item" && row.payload?.type === "message") {
      const role = row.payload.role === "assistant" ? "assistant" : row.payload.role === "user" ? "user" : null;
      if (role) pushMessage(responseMessages, role, textFromContent(row.payload.content), timestamp);
    }
    if (row?.type === "response_item" && row.payload?.type === "function_call") {
      pushMessage(responseMessages, "tool", `调用工具：${row.payload.name ?? "tool"}`, timestamp, {
        name: row.payload.name ?? "tool",
      });
    }
  }
  return eventMessages.length ? eventMessages : responseMessages;
}

function claudeMessages(rows) {
  const messages = [];
  for (const row of rows) {
    if ((row?.type === "user" || row?.type === "assistant") && !row?.isMeta) {
      pushMessage(messages, row.type, textFromContent(row.message?.content), row.timestamp ?? null);
    }
  }
  return messages;
}

export async function getSession(provider, id) {
  const sessions = await listSessions(true);
  const session = sessions.find((item) => item.provider === provider && item.id === id);
  if (!session) throw new Error("会话不存在或已被移动");
  const rows = parseLines(await readTail(session.filePath));
  const messages = provider === "codex" ? codexMessages(rows) : claudeMessages(rows);
  return {
    ...session,
    filePath: undefined,
    messages: messages.slice(-120),
  };
}

export function invalidateSessions() {
  cache.at = 0;
}
