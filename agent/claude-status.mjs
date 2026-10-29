import { readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeExecutable } from "./providers.mjs";
import { activeClaudeSessions, claudeHome } from "./claude-sessions.mjs";

const execute = promisify(execFile);
const cliPath = () => process.env.RELAYDESK_CC_SWITCH_CLI_PATH || path.join(os.homedir(), ".relaydesk", "tools", "cc-switch", "v5.11.2", "bin", process.platform === "win32" ? "cc-switch.exe" : "cc-switch");
const ccHome = () => process.env.CC_SWITCH_CONFIG_DIR || path.join(os.homedir(), ".cc-switch");
const jsonFile = async (file) => {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};
let capabilities;
export function parseClaudeCapabilities(help, version) {
  const effortText = help.match(/--effort\b[\s\S]*?(?=\n\s*--|$)/)?.[0] ?? "";
  const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"].filter((value) => new RegExp(`\\b${value}\\b`).test(effortText));
  const parts = version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [0, 0, 0];
  const atLeast = (patch) => parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= patch)));
  return { available: true, version: version.trim(), resume: /--resume\b/.test(help), newSession: /--session-id\b/.test(help), stream: /--print\b/.test(help) && /--output-format\b/.test(help) && /stream-json/.test(help), effort: reasoningEfforts.length > 0, reasoningEfforts, permissions: /--permission-mode\b/.test(help) && /dontAsk/.test(help) && /--allowedTools\b/.test(help), interactive: /--input-format\b/.test(help) && /--allow-dangerously-skip-permissions\b/.test(help) && /stream-json/.test(help), liveMessaging: atLeast(248), terminalControl: atLeast(312) };
}
export async function getClaudeCapabilities() {
  if (capabilities && Date.now() - capabilities.at < 300_000) return capabilities.value;
  try {
    const executable = claudeExecutable();
    const [help, version] = await Promise.all(["--help", "--version"].map((arg) => execute(executable.command, [...executable.prefix, arg], { windowsHide: true, timeout: 10_000, maxBuffer: 100_000 })));
    const value = parseClaudeCapabilities(help.stdout, version.stdout);
    capabilities = { at: Date.now(), value }; return value;
  } catch { return { available: false, version: "", resume: false, newSession: false, stream: false, effort: false, reasoningEfforts: [], permissions: false }; }
}

export function publicClaudeModels(settings) {
  const env = settings.env ?? {};
  const aliases = ["sonnet", "opus", "haiku", ...(env.ANTHROPIC_DEFAULT_FABLE_MODEL ? ["fable"] : [])];
  return aliases.map((alias) => ({ id: alias, model: alias, displayName: `${alias} · ${env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL_NAME`] || env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] || "跟随 Claude"}` }));
}

export async function readCcSwitchState(directory = ccHome()) {
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path.join(directory, "cc-switch.db"), { readOnly: true });
    const schema = db.prepare("PRAGMA user_version").get().user_version;
    const local = await jsonFile(path.join(directory, "settings.json"));
    const live = await jsonFile(path.join(directory, "live-state.json"));
    const rows = db.prepare("SELECT id,name,is_current FROM providers WHERE app_type = 'claude' ORDER BY sort_index,name").all();
    const mode = live.apps?.claude;
    const proxy = mode?.mode === "proxy" || Boolean(mode?.attached) || Boolean(db.prepare("SELECT live_takeover_active FROM proxy_config WHERE app_type = 'claude'").get()?.live_takeover_active);
    const currentId = (proxy ? mode?.proxy_route : null) || local.currentProviderClaude || rows.find((row) => row.is_current)?.id || "";
    return { available: true, schema, currentId, proxy, providers: rows.map((row) => ({ id: row.id, name: row.name, current: row.id === currentId })) };
  } catch { return { available: false, schema: null, currentId: "", proxy: false, providers: [] }; }
  finally { db?.close(); }
}

async function desktopRunning() {
  if (process.platform !== "win32") return true;
  const result = await execute("tasklist.exe", ["/FI", "IMAGENAME eq cc-switch.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5_000 });
  return /"cc-switch\.exe"/i.test(result.stdout);
}

export async function ccSwitchReadiness(state) {
  if (!state.available) return "未找到 CC Switch，仍可使用 Claude 当前配置";
  if (state.schema !== 20) return `CC Switch 数据库版本 ${state.schema} 尚未验证，全局切换暂不可用`;
  if (state.proxy) return "当前为 CC Switch 路由模式，请在电脑端切换供应商";
  if (process.platform !== "win32") return "当前全局切换适配仅验证了 Windows";
  try { await access(cliPath()); } catch { return "请先运行 npm run setup:ccswitch 安装兼容的切换工具"; }
  if (await desktopRunning()) return "全局切换前请从托盘退出 CC Switch，切换后可重新打开；防止桌面缓存覆盖配置";
  if ((await activeClaudeSessions()).some((row) => row.status === "busy")) return "电脑上的 Claude 正在工作，请等待完成后切换";
  return "";
}

export async function getClaudeStatus() {
  const [features, settings, cc] = await Promise.all([getClaudeCapabilities(), jsonFile(path.join(claudeHome(), "settings.json")), readCcSwitchState()]);
  const models = publicClaudeModels(settings);
  const reason = await ccSwitchReadiness(cc);
  const mode = settings.permissions?.defaultMode;
  return {
    ...features, canSend: features.available && features.resume && features.stream && features.permissions,
    models, defaultSettings: { model: settings.model || settings.env?.ANTHROPIC_MODEL || "sonnet", reasoning: settings.effortLevel || "", permission: mode === "bypassPermissions" ? "full" : mode === "plan" ? "read-only" : mode === "acceptEdits" ? "workspace" : "ask", serviceTier: "" },
    ccSwitch: { ...cc, canSwitch: !reason, reason }, updatedAt: Date.now(),
  };
}

let switching = false;
export async function switchGlobalProvider(id) {
  if (switching) throw new Error("正在切换供应商，请等待确认");
  switching = true;
  try {
    const cc = await readCcSwitchState();
    if (!cc.providers.some((provider) => provider.id === id)) throw new Error("这个供应商不存在，请刷新列表");
    if (cc.currentId === id) return getClaudeStatus();
    const reason = await ccSwitchReadiness(cc);
    if (reason) throw new Error(reason);
    const version = await execute(cliPath(), ["--version"], { windowsHide: true, timeout: 5_000 });
    if (!/^cc-switch 5\.11\.2\s*$/.test(version.stdout.trim())) throw new Error("CC Switch CLI 版本未验证，已保留原配置");
    try {
      await execute(cliPath(), ["--app", "claude", "provider", "switch", id], { windowsHide: true, timeout: 30_000, maxBuffer: 100_000, env: { ...process.env, CC_SWITCH_CONFIG_DIR: ccHome() } });
    } catch { throw new Error("CC Switch 切换未确认，请在电脑检查当前供应商后再操作"); }
    const updated = await readCcSwitchState();
    if (updated.schema !== cc.schema || updated.currentId !== id) throw new Error("全局供应商状态尚未确认，请在电脑检查");
    return getClaudeStatus();
  } finally { switching = false; }
}
