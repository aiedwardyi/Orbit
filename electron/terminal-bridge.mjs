import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const GRANT_PREFIX = "orbit-terminal-read-v1";

export function terminalReadGrant(token, botId) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || typeof botId !== "string" || !BOT_ID_RE.test(botId)) {
    throw new Error("Invalid terminal read grant");
  }
  return createHmac("sha256", token).update(`${GRANT_PREFIX}:${botId}`).digest("base64url");
}

function bearerMatches(header, token, botId) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- HTTP authorization is untyped request input.
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(terminalReadGrant(token, botId));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/** Private loopback bridge between the Electron terminal host and a scoped MCP proxy. */
export function createTerminalBridge({ host, token = randomBytes(24).toString("hex"), port = 0 } = {}) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The host is supplied by the Electron main process.
  if (!host || typeof host.readBot !== "function") throw new Error("Terminal host is required");
  let server;
  let address;
  const start = () => new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      let parsed;
      try {
        parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        return json(res, 400, { error: "Invalid terminal request" });
      }
      const match = parsed.pathname.match(/^\/v1\/bots\/([a-zA-Z0-9_-]{1,128})\/terminal(?:\/(send))?$/);
      if (!match || !BOT_ID_RE.test(match[1])) return json(res, 404, { error: "Unknown terminal route" });
      const botId = match[1];
      if (!bearerMatches(req.headers.authorization, token, botId)) return json(res, 401, { error: "Unauthorized" });
      try {
        if (req.method === "GET" && !match[2]) return json(res, 200, host.readBot(botId));
        return json(res, 405, { error: "Method not allowed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /stale|No active|exited|Unknown terminal/i.test(message) ? 409 : /Invalid/i.test(message) ? 400 : 500;
        return json(res, status, { error: message });
      }
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
      if (!address || typeof address === "string") return reject(new Error("Terminal bridge did not bind"));
      resolve({ url: `http://127.0.0.1:${address.port}`, token });
    });
  });
  const close = () => new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  return {
    start,
    close,
    credentials: () => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
      if (!address || typeof address === "string") return null;
      return { url: `http://127.0.0.1:${address.port}`, token };
    },
  };
}
