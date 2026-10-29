// Runs inside Claude's documented hook lifecycle. No prompts, credentials or
// decisions are logged; a missing RelayDesk falls back to Claude's terminal UI.
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findClaudeParent } from "./claude-process.mjs";

async function main() {
  let text = "";
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 512000) return; }
  const input = JSON.parse(text), event = input.hook_event_name;
  // Managed runs already have the bidirectional SDK permission host. Installing
  // the terminal hooks must not make a user answer the same request twice.
  if (process.env.RELAYDESK_MANAGED_SESSION && ["PermissionRequest", "PreToolUse"].includes(event)) return;
  const parent = event === "SessionStart" ? await findClaudeParent() : null;
  const config = JSON.parse(await readFile(path.join(process.env.RELAYDESK_STATE_DIR || path.join(os.homedir(), ".relaydesk"), "config.json"), "utf8"));
  const payload = { ...input, hookPid: process.pid,
    ...(event === "SessionStart" ? { socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN, claudePid: parent?.pid, startedAt: parent?.startedAt, home: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), managed: Boolean(process.env.RELAYDESK_MANAGED_SESSION) } : {}),
    ...(event === "SessionEnd" ? { connectionToken: process.env.CLAUDE_CODE_MESSAGING_TOKEN } : {}),
  };
  const target = new URL(process.env.RELAYDESK_HOOK_URL || "http://127.0.0.1:43127/api/claude/hook");
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/api/claude/hook") return;
  const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "x-relaydesk-control": config.controlToken }, body: JSON.stringify(payload), signal: AbortSignal.timeout(event === "PermissionRequest" || event === "PreToolUse" ? 550000 : 3000) });
  if (!response.ok) return;
  const result = await response.json();
  if (result.output) process.stdout.write(JSON.stringify(result.output));
}
main().catch(() => { /* Let the real terminal handle the request. */ });
