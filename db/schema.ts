import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  agentTokenHash: text("agent_token_hash").notNull().unique(),
  publicKey: text("public_key").notNull(),
  codeHash: text("code_hash").unique(),
  codeExpiresAt: integer("code_expires_at"),
  pairedAt: integer("paired_at"),
  lastSeenAt: integer("last_seen_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    publicKey: text("public_key").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("clients_device_idx").on(table.deviceId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: text("device_id").notNull(),
    senderId: text("sender_id").notNull(),
    targetId: text("target_id").notNull(),
    kind: text("kind").notNull(),
    envelope: text("envelope").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("messages_target_idx").on(table.targetId, table.id),
    index("messages_created_idx").on(table.createdAt),
  ],
);

export const pairAttempts = sqliteTable("pair_attempts", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
});
