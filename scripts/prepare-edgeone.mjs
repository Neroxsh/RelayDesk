import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "edgeone-dist");
const client = path.join(root, "dist", "client");
const edgeFunctions = path.join(root, "edgeone", "edge-functions");
const edgePackage = path.join(root, "edgeone", "package.json");
const edgeDependencies = path.join(root, "edgeone", "node_modules", "@edgeone");
const savedShell = path.join(root, "edgeone", "shell.html");
const sourceUrl = (process.env.RELAYDESK_SHELL_URL || "https://relay.xingshihao.site").replace(/\/$/, "");

const builtManifest = JSON.parse(await readFile(path.join(client, ".vite", "manifest.json"), "utf8"));
const pageAsset = builtManifest["app/page.tsx"]
  ?? Object.values(builtManifest).find((entry) => entry.name === "page");
if (!pageAsset?.file) throw new Error("找不到手机端页面构建产物");

let html = await readFile(savedShell, "utf8");
if (process.env.RELAYDESK_REFRESH_SHELL === "1") {
  const response = await fetch(`${sourceUrl}/?edgeone-build=${Date.now()}`, {
    headers: {
      "cache-control": "no-cache",
      "user-agent": "Mozilla/5.0 RelayDesk EdgeOne Builder",
    },
  });
  if (!response.ok) throw new Error(`无法读取已发布的手机页面（${response.status}）`);
  html = await response.text();
}
if (!html.includes(`/assets/${path.basename(pageAsset.file)}`)) {
  throw new Error("线上页面与本地构建版本不一致，请先发布当前 Sites 版本");
}

const resolvedOutput = path.resolve(output);
if (path.dirname(resolvedOutput) !== root || path.basename(resolvedOutput) !== "edgeone-dist") {
  throw new Error("EdgeOne 输出目录无效");
}
await rm(resolvedOutput, { recursive: true, force: true });
await cp(client, resolvedOutput, { recursive: true });
await mkdir(path.join(resolvedOutput, "edge-functions"), { recursive: true });
await cp(edgeFunctions, path.join(resolvedOutput, "edge-functions"), { recursive: true });
await cp(edgePackage, path.join(resolvedOutput, "package.json"));
await mkdir(path.join(resolvedOutput, "node_modules", "@edgeone"), { recursive: true });
await cp(edgeDependencies, path.join(resolvedOutput, "node_modules", "@edgeone"), { recursive: true });
await writeFile(path.join(resolvedOutput, "index.html"), html, "utf8");

console.log(`EdgeOne 部署包已生成：${resolvedOutput}`);
