import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = path.join(projectRoot, "agent", "index.mjs");
const installer = path.join(projectRoot, "scripts", "install-agent.ps1");
const defaultRelay = "https://relay.xingshihao.site";
const controlUrl = "http://127.0.0.1:43127";

function value(name) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function commandExists(name) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(command, [name], { windowsHide: true, stdio: "ignore" }).status === 0;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function installMacStartup(relay) {
  const home = os.homedir();
  const stateDirectory = path.join(home, ".relaydesk");
  const launchDirectory = path.join(home, "Library", "LaunchAgents");
  const label = "site.xingshihao.relaydesk";
  const plistPath = path.join(launchDirectory, `${label}.plist`);
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(launchDirectory, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string><string>${xml(agent)}</string><string>start</string><string>--relay</string><string>${xml(relay)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(stateDirectory, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDirectory, "agent-error.log"))}</string>
</dict></plist>\n`;
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  await writeFile(plistPath, plist, "utf8");
  const loaded = spawnSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
  if (loaded.status !== 0) throw new Error("无法注册 macOS 后台服务");
  spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
}

function supportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 22;
}

function printLinks(relay) {
  console.log("\nRelayDesk 已准备好：");
  console.log(`  电脑端  ${controlUrl}`);
  console.log(`  手机端  ${relay}`);
  console.log("\n首次使用：在手机输入电脑端显示的配对码，然后回到电脑确认。\n");
}

async function confirmStartup() {
  if (process.argv.includes("--yes") || !process.stdin.isTTY) return true;
  const terminal = createInterface({ input, output });
  try {
    const answer = (await terminal.question("让 RelayDesk 随电脑开机启动？[Y/n] ")).trim().toLowerCase();
    return !["n", "no"].includes(answer);
  } finally {
    terminal.close();
  }
}

async function main() {
  if (!supportedNode()) throw new Error("需要 Node.js 22 或更高版本");
  const relay = String(value("relay") ?? process.env.RELAYDESK_URL ?? defaultRelay).replace(/\/+$/, "");
  const automatic = await confirmStartup();
  const dryRun = process.argv.includes("--dry-run");
  const hasCodex = commandExists("codex");

  console.log(`Codex：${hasCodex ? "已安装" : "未找到"}`);
  if (!hasCodex) console.log("可以先完成 RelayDesk 安装；安装并登录 Codex 后，会话会自动出现。");
  if (dryRun) {
    printLinks(relay);
    return;
  }

  if (process.platform === "win32" && automatic) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", installer,
      "-RelayUrl", relay,
    ], { cwd: projectRoot, windowsHide: false, stdio: "inherit" });
    if (result.status !== 0) throw new Error("安装后台服务失败");
  } else if (process.platform === "darwin" && automatic) {
    await installMacStartup(relay);
    spawnSync("open", [controlUrl], { stdio: "ignore" });
  } else {
    const child = spawn(process.execPath, [agent, "start", "--relay", relay], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    const control = spawn(process.execPath, [agent, "control", "--relay", relay], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    control.unref();
  }
  printLinks(relay);
}

main().catch((error) => {
  console.error(`RelayDesk 安装失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
