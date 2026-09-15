// MSP JSON-RPC framing over `muse serve` stdio, plus UUIDv7 command ids.
// Transport-only: session/turn semantics live in runtime.ts.
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** Time-ordered id for MSP commandId (the host rejects non-UUIDv7). */
export function uuidv7(nowMs = Date.now(), rand = Math.random): string {
  const t = nowMs.toString(16).padStart(12, "0").slice(-12);
  const a = Math.floor(rand() * 0xfff)
    .toString(16)
    .padStart(3, "0");
  const rest = Array.from(
    { length: 4 },
    () => Math.floor(rand() * 0xffff).toString(16).padStart(4, "0"),
  )
    .join("")
    .slice(-15);
  const variant = "89ab"[Math.floor(rand() * 4)];
  return `${t.slice(0, 8)}-${t.slice(8)}-7${a}-${variant}${rest.slice(0, 3)}-${rest.slice(3)}`;
}

export class MspRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface MspChannel {
  request(method: string, params: unknown, timeoutMs: number): Promise<any>;
  notify(method: string, params: unknown): void;
  respond(id: number | string, result: unknown): void;
  onNotification(fn: (method: string, params: any) => void): () => void;
  /** Server-initiated requests (approval/request, userInput/request): an id
   * with no matching client call. Unhandled methods get -32601, mirroring
   * the ACP core — the host blocks while one hangs. */
  onServerRequest(fn: ((id: number | string, method: string, params: any) => unknown) | null): void;
  onExit(fn: (code: number | null, stderr: string) => void): () => void;
  /** Forget every pending call and listener; the child itself is runtime-owned. */
  detach(): void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createMspChannel(child: ChildProcessByStdio<Writable, Readable, Readable>): MspChannel {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const notifListeners = new Set<(method: string, params: any) => void>();
  let serverHandler: ((id: number | string, method: string, params: any) => unknown) | null = null;
  const exitListeners = new Set<(code: number | null, stderr: string) => void>();
  const answer = (id: number | string, payload: Record<string, unknown>) => {
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
    } catch {
      // the turn fails on its next await; a lost receipt re-issues on subscribe
    }
  };
  let stderrTail = "";
  let exited = false;

  const failAll = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2000);
  });
  child.on("exit", (code) => {
    exited = true;
    failAll(new Error(`serve exited ${code ?? "unknown"}${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ""}`));
    for (const fn of [...exitListeners]) fn(code, stderrTail);
  });
  child.on("error", (err) => {
    failAll(err instanceof Error ? err : new Error(String(err)));
  });

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += String(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined && msg.error !== null) {
          const { code, message, data } = msg.error ?? {};
          p.reject(new MspRpcError(`MSP ${message ?? "request failed"}`, code, data));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method && serverHandler) {
        try {
          const receipt = serverHandler(msg.id, msg.method, msg.params);
          Promise.resolve(receipt).then(
            (result) => answer(msg.id, { result: result ?? {} }),
            () => answer(msg.id, { error: { code: -32603, message: "could not present the request" } }),
          );
        } catch {
          answer(msg.id, { error: { code: -32603, message: "could not present the request" } });
        }
      } else if (msg.id !== undefined && msg.method) {
        answer(msg.id, { error: { code: -32601, message: "method not found" } });
      } else if (msg.method) {
        for (const fn of [...notifListeners]) fn(msg.method, msg.params);
      }
    }
  });

  return {
    request(method, params, timeoutMs) {
      if (exited) return Promise.reject(new Error(`serve exited before ${method}`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MSP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    notify(method, params) {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      } catch {
        // notifications are fire-and-forget; the turn fails on its next await
      }
    },
    respond(id, result) {
      answer(id, { result });
    },
    onNotification(fn) {
      notifListeners.add(fn);
      return () => {
        notifListeners.delete(fn);
      };
    },
    onServerRequest(fn) {
      serverHandler = fn;
    },
    onExit(fn) {
      exitListeners.add(fn);
      return () => {
        exitListeners.delete(fn);
      };
    },
    detach() {
      failAll(new Error("turn settled"));
      notifListeners.clear();
      serverHandler = null;
      exitListeners.clear();
    },
  };
}
