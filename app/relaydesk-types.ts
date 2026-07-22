export type Provider = "codex";
export type PermissionMode = "read-only" | "workspace" | "full";

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  serviceTiers: Array<{ id: string; name: string; description?: string }>;
  defaultServiceTier: string | null;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

export type CodexStatus = {
  available: boolean;
  models: CodexModel[];
  account: { type: string | null; planType: string | null } | null;
  usage: {
    planType: string | null;
    primary: RateLimitWindow | null;
    secondary: RateLimitWindow | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  };
  platform: { os: string; release: string; arch: string };
  updatedAt: number;
};

export type RunSettings = {
  model: string;
  reasoning: string;
  permission: PermissionMode;
  serviceTier: string;
};

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
