import { env } from "cloudflare:workers";

type D1ResultRow = Record<string, unknown>;

let schemaPromise: Promise<void> | undefined;

export function store(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("RelayDesk database is unavailable");
  return db;
}

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    const db = store();
    schemaPromise = db
      .batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          agent_token_hash TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL,
          code_hash TEXT UNIQUE,
          code_expires_at INTEGER,
          paired_at INTEGER,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          revoked_at INTEGER
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          envelope TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS pair_attempts (
          bucket TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS messages_target_idx ON messages(target_id, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS clients_device_idx ON clients(device_id)"),
      ])
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaPromise = undefined;
        throw error;
      });
  }
  return schemaPromise!;
}

export async function first<T extends D1ResultRow>(statement: D1PreparedStatement) {
  return (await statement.first<T>()) ?? null;
}

export function now() {
  return Date.now();
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export async function authenticateAgent(request: Request) {
  await ensureSchema();
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return first<{ id: string; name: string; public_key: string }>(
    store().prepare("SELECT id, name, public_key FROM devices WHERE agent_token_hash = ?").bind(tokenHash),
  );
}

export async function authenticateClient(request: Request) {
  await ensureSchema();
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return first<{ id: string; device_id: string; public_key: string }>(
    store()
      .prepare("SELECT id, device_id, public_key FROM clients WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(tokenHash),
  );
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function readJson<T>(request: Request, maxBytes = 1_100_000): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("请求内容过大");
  return (await request.json()) as T;
}

export function validId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(value);
}

export function validPublicKey(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string";
}

export async function rateLimitPair(request: Request) {
  const db = store();
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "local";
  const bucket = await sha256(`pair:${ip.split(",")[0].trim()}`);
  const current = now();
  const row = await first<{ count: number; reset_at: number }>(
    db.prepare("SELECT count, reset_at FROM pair_attempts WHERE bucket = ?").bind(bucket),
  );
  if (!row || row.reset_at <= current) {
    await db
      .prepare("INSERT INTO pair_attempts(bucket, count, reset_at) VALUES(?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at")
      .bind(bucket, current + 15 * 60_000)
      .run();
    return true;
  }
  if (row.count >= 8) return false;
  await db.prepare("UPDATE pair_attempts SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return true;
}
