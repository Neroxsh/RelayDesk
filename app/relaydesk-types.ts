export type Provider = "codex" | "claude";

export type ClaudeStatus = {
  available: boolean;
  version: string;
  canSend: boolean;
  newSession: boolean;
  effort: boolean;
  reasoningEfforts: string[];
  models: Array<{ id: string; model: string; displayName: string }>;
  defaultSettings: RunSettings;
  ccSwitch: { available: boolean; schema: number | null; currentId: string; canSwitch: boolean; reason: string; providers: Array<{ id: string; name: string; current: boolean }> };
  updatedAt: number;
};
export type PermissionMode = "read-only" | "ask" | "workspace" | "full";

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
  source?: "desktop" | "cli";
  stale?: boolean;
  warnings?: string[];
  desktopSettingsOnly?: boolean;
  defaultSettings?: RunSettings | null;
  usage: {
    planType: string | null;
    primary: RateLimitWindow | null;
    secondary: RateLimitWindow | null;
    buckets?: Array<{ id: string; name: string; primary: RateLimitWindow | null; secondary: RateLimitWindow | null }>;
    availableResetCount?: number | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
    activity: {
      lifetimeTokens: number;
      peakDailyTokens: number;
      longestRunningTurnSec: number;
      currentStreakDays: number;
      longestStreakDays: number;
      daily: Array<{ startDate: string; tokens: number }>;
    } | null;
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
  requestId?: string;
  delivery?: string;
  error?: string;
};

export type ActivityItem = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  timestamp?: string | null;
};

export type InteractionRequest = {
  id: string; kind: "approval" | "question" | "notice"; title: string; description?: string; tool?: string;
  choices: string[]; createdAt?: number;
  questions?: Array<{ id: string; header?: string; question: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
};
export type SessionControl = {
  available: boolean; canSend?: boolean; canStop?: boolean; canSetPermissions?: boolean;
  source?: string; reason?: string; pending?: InteractionRequest[];
  planReady?: boolean; planId?: string;
};

export type SessionDetail = SessionSummary & {
  control?: SessionControl | null;
  terminalOpen?: boolean;
  messages: Message[];
  activity?: ActivityItem[];
  state?: "idle" | "working";
  settings?: RunSettings & { source?: string };
};

export type OutboxEntry = {
  requestId: string;
  sessionKey: string;
  payload: RemotePayload;
  createdAt: number;
  updatedAt: number;
  status: string;
  error?: string;
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
