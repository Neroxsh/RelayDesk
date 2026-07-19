import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = path.join(projectRoot, "agent", "index.mjs");
const installer = path.join(projectRoot, "scripts", "install-agent.ps1");
const defaultRelay = "https://relay.xingshihao.site";

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

function supportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 22;
}

function printLinks(relay) {
  console.log("\nRelayDesk 已准备好：");
  console.log("  电脑端  http://127.0.0.1:43127");
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
  const providers = ["codex", "claude"].filter(commandExists);

  console.log(`检测到：${providers.length ? providers.join("、") : "尚未安装 Codex 或 Claude Code"}`);
  if (!providers.length) console.log("RelayDesk 仍可安装；安装任一工具并登录后，会话会自动出现。");
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
