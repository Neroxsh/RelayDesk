import type { Message, OutboxEntry } from "./relaydesk-types";

export function readOutbox(storage: Pick<Storage, "getItem">, clientId: string): OutboxEntry[] {
  try {
    const entries: unknown = JSON.parse(storage.getItem(`relaydesk.outbox.${clientId}`) ?? "[]");
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is OutboxEntry => Boolean(entry && typeof entry.requestId === "string"
      && typeof entry.sessionKey === "string" && entry.payload?.type === "session:send" && typeof entry.payload.prompt === "string"
      && Number.isFinite(entry.createdAt) && Date.now() - entry.createdAt < 24 * 60 * 60_000)).slice(-30);
  } catch { return []; }
}

export function writeOutbox(storage: Pick<Storage, "setItem">, clientId: string, entries: OutboxEntry[]) {
  storage.setItem(`relaydesk.outbox.${clientId}`, JSON.stringify(entries.slice(-30)));
}

export function outboxMessage(entry: OutboxEntry): Message {
  return {
    id: `local-${entry.requestId}`, requestId: entry.requestId, role: "user", content: String(entry.payload.prompt),
    timestamp: new Date(entry.createdAt).toISOString(), pending: true, delivery: entry.status, error: entry.error,
  };
}

export function readDraft(storage: Pick<Storage, "getItem">, clientId: string, sessionKey: string) {
  try { return storage.getItem(`relaydesk.draft.${clientId}.${sessionKey}`) ?? ""; } catch { return ""; }
}

export function writeDraft(storage: Pick<Storage, "setItem">, clientId: string, sessionKey: string, draft: string) {
  try { storage.setItem(`relaydesk.draft.${clientId}.${sessionKey}`, draft); } catch { /* Keep the in-memory draft if storage is full. */ }
}
