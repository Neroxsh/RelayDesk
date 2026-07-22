import type { Message, Provider } from "./relaydesk-types";

export const PROVIDERS: Record<Provider, { name: string; short: string; company: string }> = {
  codex: { name: "Codex", short: "C", company: "OpenAI" },
};

export const STORAGE_KEY = "relaydesk.pairing.v2";
export const LEGACY_STORAGE_KEY = "relaydesk.pairing.v1";
export const PENDING_KEY = "relaydesk.pending.v2";

export function cursorKey(clientId: string) {
  return `relaydesk.cursor.${clientId}`;
}

export function normalizePairKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 16);
}

export function formatPairKey(value: string) {
  return normalizePairKey(value).match(/.{1,4}/g)?.join("-") ?? "";
}

export function formatWhen(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

export function formatMessageTime(timestamp?: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function phoneName() {
  const value = navigator.userAgent;
  if (/iPhone/i.test(value)) return "iPhone";
  if (/iPad/i.test(value)) return "iPad";
  if (/Android/i.test(value)) return "Android 手机";
  return "手机浏览器";
}

export function providerName(provider: Provider) {
  return PROVIDERS[provider].name;
}

export function messageSignature(message: Message) {
  return `${message.role}\u0000${message.timestamp ?? ""}\u0000${message.content}`;
}

export function mergeSessionMessages(previous: Message[], incoming: Message[]) {
  const merged = [...previous];
  const seen = new Set(previous.map(messageSignature));
  for (const message of incoming) {
    const signature = messageSignature(message);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(message);
  }
  return merged.slice(-240);
}
