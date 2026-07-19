const DEFAULT_ORIGIN = "https://relaydesk-private-remote.able-bream-1696.chatgpt.site";

export default async function onRequest(context) {
  const request = context.request;
  const incoming = new URL(request.url);
  const origin = String(context.env?.RELAYDESK_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${origin}/`);

  const headers = new Headers(request.headers);
  for (const name of [
    "host",
    "content-length",
    "origin",
    "referer",
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
  ]) headers.delete(name);
  headers.set("accept-encoding", "identity");
  headers.set("x-relaydesk-edge", "edgeone");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("content-length");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
