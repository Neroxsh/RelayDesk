const EDGEONE_ORIGIN = "https://relaydesk-direct-lx7qr5rj.edgeone.dev";
const TRANSIENT_ORIGIN_STATUS = new Set([520, 522, 523, 524, 525, 526, 545]);

export default {
  async fetch(request) {
    const target = new URL(request.url);
    const origin = new URL(EDGEONE_ORIGIN);

    target.protocol = origin.protocol;
    target.hostname = origin.hostname;
    target.port = origin.port;

    const safeToRetry = request.method === "GET"
      || (request.method === "POST" && ["/api/agent/heartbeat", "/api/device/register"].includes(target.pathname));
    const attempts = safeToRetry ? 3 : 1;
    let response;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      response = await fetch(new Request(target, request.clone()));
      if (!TRANSIENT_ORIGIN_STATUS.has(response.status)) return response;
    }
    return response;
  },
};
