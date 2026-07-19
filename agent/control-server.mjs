import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROL_PORT = 43127;
export const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const CONTROL_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "control.html");

function reply(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(request) {
  let value = "";
  for await (const chunk of request) {
    value += chunk.toString("utf8");
    if (value.length > 16_000) throw new Error("请求内容过大");
  }
  return value ? JSON.parse(value) : {};
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export async function startControlServer({ controlToken, getState, approve, reject, revoke, updateSettings }) {
  const template = await readFile(CONTROL_HTML, "utf8");
  const server = http.createServer(async (request, response) => {
    try {
      if (!isLoopback(request.socket.remoteAddress)) {
        reply(response, 403, { error: "仅允许本机访问" });
        return;
      }
      const url = new URL(request.url ?? "/", CONTROL_URL);
      if (request.method === "GET" && url.pathname === "/") {
        reply(response, 200, template.replace("__CONTROL_TOKEN__", controlToken), "text/html; charset=utf-8");
        return;
      }
      if (request.headers["x-relaydesk-control"] !== controlToken) {
        reply(response, 403, { error: "本机控制认证失败" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        reply(response, 200, await getState());
        return;
      }
      if (request.method === "POST" && ["/api/approve", "/api/reject", "/api/revoke", "/api/settings"].includes(url.pathname)) {
        const body = await readBody(request);
        const handler = url.pathname === "/api/approve"
          ? approve
          : url.pathname === "/api/reject"
            ? reject
            : url.pathname === "/api/revoke"
              ? revoke
              : updateSettings;
        reply(response, 200, await handler(body));
        return;
      }
      reply(response, 404, { error: "页面不存在" });
    } catch (error) {
      reply(response, 500, { error: error instanceof Error ? error.message : "操作失败" });
    }
  });
  await new Promise((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(CONTROL_PORT, "127.0.0.1", resolve);
  });
  return server;
}

export function openControlPanel() {
  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [CONTROL_URL], { windowsHide: true, detached: true, stdio: "ignore" });
    child.unref();
  }
}
