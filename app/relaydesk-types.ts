export type Provider = "codex" | "claude";
export type PermissionMode = "safe" | "full";

export type SessionSummary = {
  id: string;
  key: string;
  provider: Provider;
  title: string;
  cwd: string;
  projectName?: string;
  projectPath?: string;
  updatedAt: number;
  recent?: boolean;
  active?: boolean;
  currentWindow?: boolean;
  openInCodex?: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string | null;
  pending?: boolean;
};

export type ActivityItem = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  timestamp?: string | null;
};

export type SessionDetail = SessionSummary & {
  messages: Message[];
  activity?: ActivityItem[];
  state?: "idle" | "working";
};

export type StoredPairing = {
  clientId: string;
  clientToken: string;
  key: string;
  device: { id: string; name: string; platform: string };
};

export type PendingPair = {
  requestId: string;
  pollToken: string;
  privateKey: JsonWebKey;
  pairKeyHash: string;
  deviceName: string;
  expiresAt: number;
};

export type DeviceStatus = {
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt: number;
};

export type ProjectGroup = {
  name: string;
  path: string;
  sessions: SessionSummary[];
  updatedAt: number;
};

export type RemotePayload = Record<string, unknown> & { type?: string; requestId?: string };

export type PollResponse = {
  error?: string;
  cursor?: number;
  device?: DeviceStatus | null;
  messages?: Array<{ id: number; kind: string; envelope: string }>;
};
