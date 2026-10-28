/** @param {{role: string, content: string, timestamp?: string | null}} message */
export function messageSignature(message) {
  return `${message.role}\u0000${message.timestamp ?? ""}\u0000${message.content}`;
}

/**
 * Merge a transcript with delayed snapshots or local echoes in chronological order.
 * Match echoes one-to-one so two identical requests remain two requests.
 * @template {{id: string, role: string, content: string, timestamp?: string | null, pending?: boolean}} T
 * @param {T[]} previous
 * @param {T[]} incoming
 * @param {number} [limit]
 * @returns {T[]}
 */
export function mergeTimelineMessages(previous, incoming, limit = 240) {
  const merged = [];
  const signatures = new Map();
  const ids = new Map();
  for (const message of [...previous, ...incoming]) {
    const signature = messageSignature(message);
    const index = ids.get(message.id) ?? signatures.get(signature);
    if (index !== undefined) {
      if (!merged[index].pending && message.pending && merged[index].id !== message.id) continue;
      merged[index] = { ...merged[index], ...message, pending: Boolean(message.pending) };
    } else {
      ids.set(message.id, merged.length);
      signatures.set(signature, merged.length);
      merged.push(message);
    }
  }
  const claimed = new Set();
  const pending = merged.filter((message) => message.pending);
  for (const echo of pending) {
    const sentAt = Date.parse(echo.timestamp ?? "");
    const match = merged.find((message, index) => {
      if (message.pending || claimed.has(index) || message.role !== echo.role || message.content !== echo.content) return false;
      const at = Date.parse(message.timestamp ?? "");
      return Number.isFinite(sentAt) && Number.isFinite(at) && at >= sentAt - 3_000 && at <= sentAt + 10 * 60_000;
    });
    if (match) {
      claimed.add(merged.indexOf(match));
      claimed.add(echo);
    }
  }
  let lastKnown = merged.map((message) => Date.parse(message.timestamp ?? "")).find(Number.isFinite) ?? 0;
  return merged.map((message, index) => {
    const timestamp = Date.parse(message.timestamp ?? "");
    if (Number.isFinite(timestamp)) lastKnown = timestamp;
    return { message, index, at: lastKnown };
  })
    .filter(({ message }) => !claimed.has(message))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(-limit)
    .map(({ message }) => message);
}
