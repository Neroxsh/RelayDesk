const EDGEONE_ORIGIN = "https://relaydesk-direct-lx7qr5rj.edgeone.dev";

export default {
  fetch(request) {
    const target = new URL(request.url);
    const origin = new URL(EDGEONE_ORIGIN);

    target.protocol = origin.protocol;
    target.hostname = origin.hostname;
    target.port = origin.port;

    return fetch(new Request(target, request));
  },
};
