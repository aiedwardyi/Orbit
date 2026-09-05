// Thin packaged listen: /api/health + static UI before the fat harness
// module evaluates. Electron can reveal the chat shell while registry
// load, store hydrate, and PATH/CLI describe still run in the child.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

export const EARLY_LISTEN_SLOT = Symbol.for("orbit.earlyListen");

export const EARLY_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export type HarnessHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

export type EarlyListen = {
  server: Server;
  port: number;
  staticDir: string | null;
  setHandler: (handler: HarnessHandler) => void;
};

type EarlyListenSlot = typeof globalThis & { [EARLY_LISTEN_SLOT]?: EarlyListen };

export function isEarlyPublicPath(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (pathname === "/api/health") return true;
  return !pathname.startsWith("/api/");
}

export function healthBody(staticDir: string | null) {
  return { app: "openmausbot", pid: process.pid, static: Boolean(staticDir) };
}

/** Held `/api/*` requests waiting for the fat harness. Crash-safe: extras get 503. */
export const MAX_QUEUED_EARLY_REQUESTS = 64;

/** Resolve a URL path under `staticDir`. Null if it would escape the UI root. */
export function resolvedStaticPath(staticDir: string, pathname: string): string | null {
  if (pathname.includes("\0") || pathname.includes("..")) return null;
  const suffix = pathname === "/" ? "/index.html" : pathname;
  const root = resolve(staticDir);
  const candidate = resolve(join(root, suffix));
  const rel = relative(root, candidate);
  if (!rel || rel.split(/[/\\]/).includes("..") || isAbsolute(rel)) return null;
  if (resolve(root, rel) !== candidate) return null;
  return candidate;
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

export function serveEarlyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { staticDir?: string | null } = {},
): boolean {
  const method = req.method ?? "GET";
  const pathname = pathnameOf(req);
  if (!isEarlyPublicPath(method, pathname)) return false;
  if (pathname === "/api/health") {
    const data = JSON.stringify(healthBody(options.staticDir ?? null));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(data);
    return true;
  }
  const staticDir = options.staticDir;
  if (!staticDir) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
  const file = resolvedStaticPath(staticDir, pathname);
  if (!file) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": EARLY_MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    try {
      const data = readFileSync(join(staticDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(data);
      return true;
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return true;
    }
  }
}

export function currentEarlyListen(): EarlyListen | null {
  return (globalThis as EarlyListenSlot)[EARLY_LISTEN_SLOT] ?? null;
}

export function startEarlyListen(options: { port?: number; staticDir?: string | null } = {}): EarlyListen {
  const existing = currentEarlyListen();
  if (existing) return existing;

  const port = Number(options.port ?? process.env.OMB_PORT ?? process.env.OGB_PORT ?? 8799);
  const queued: Array<{ req: IncomingMessage; res: ServerResponse }> = [];
  let handler: HarnessHandler | null = null;

  const early: EarlyListen = {
    server: undefined as unknown as Server,
    port,
    staticDir: options.staticDir ?? process.env.OMB_STATIC_DIR ?? null,
    setHandler(next) {
      handler = next;
      const pending = queued.splice(0);
      for (const { req, res } of pending) {
        if (req.destroyed || res.writableEnded) continue;
        void next(req, res);
      }
    },
  };

  early.server = createServer((req, res) => {
    if (handler) {
      void handler(req, res);
      return;
    }
    if (serveEarlyRequest(req, res, { staticDir: early.staticDir })) return;
    if (queued.length >= MAX_QUEUED_EARLY_REQUESTS) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("unavailable");
      return;
    }
    const onClose = () => {
      const index = queued.findIndex((item) => item.req === req);
      if (index >= 0) queued.splice(index, 1);
    };
    req.once("close", onClose);
    queued.push({ req, res });
  });

  (globalThis as EarlyListenSlot)[EARLY_LISTEN_SLOT] = early;
  early.server.listen(port, "127.0.0.1", () => {
    if (port !== 0) {
      console.log(`openmausbot server on http://127.0.0.1:${port}`);
    }
  });
  return early;
}

export async function resetEarlyListenForTests(): Promise<void> {
  const early = currentEarlyListen();
  delete (globalThis as EarlyListenSlot)[EARLY_LISTEN_SLOT];
  if (!early) return;
  early.server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    early.server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
