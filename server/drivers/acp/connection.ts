import type { spawnCli } from "../../procs.ts";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Lifetime JSON-RPC transport for one ACP child. Monotonic request ids and a
 * single stdout parser outlive individual turns; per-turn handlers rebind
 * onRequest / onNotification. Shared by every ACP harness — failure settlement
 * must not change non-Grok semantics beyond rejecting pending RPCs promptly.
 */
export function acpConnection(
  child: ReturnType<typeof spawnCli>,
  log: (dir: "in" | "out", msg: unknown) => void,
) {
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;
  const pending = new Map<number, Pending>();

  const failTransport = (error: Error) => {
    if (closed) {
      // closed was already set (either by a prior failTransport call or by the
      // close handler); just flush any remaining pending RPCs and bail.
      connection.rejectPending(error.message);
      return;
    }
    closed = true;
    connection.rejectPending(error.message);
    try {
      connection.onError(error);
    } catch {
      // Listener errors must not escape the child signal path.
    }
  };

  const connection = {
    child,
    get healthy() {
      return !closed && !child.killed && child.exitCode === null;
    },
    onRequest: (_msg: any) => {},
    onNotification: (_msg: any) => {},
    onError: (_error: Error) => {},
    onClose: (_code: number | null, _stderr: string) => {},
    send(msg: unknown): boolean {
      if (!connection.healthy) return false;
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
        log("out", msg);
        return true;
      } catch (error) {
        failTransport(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
      if (!connection.healthy) return Promise.reject(new Error("process closed"));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = timeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`${method} timed out`));
            }, timeoutMs)
          : undefined;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        if (!connection.send({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("process closed"));
        }
      });
    },
    rejectPending(message: string) {
      for (const value of pending.values()) {
        clearTimeout(value.timer);
        value.reject(new Error(message));
      }
      pending.clear();
    },
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      log("in", msg);
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const value = pending.get(msg.id);
        if (!value) continue;
        pending.delete(msg.id);
        clearTimeout(value.timer);
        if (msg.error) {
          value.reject(
            Object.assign(new Error(msg.error.message ?? JSON.stringify(msg.error)), {
              code: msg.error.code,
              data: msg.error.data,
            }),
          );
        } else {
          value.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) {
        connection.onRequest(msg);
      } else if (msg.method) {
        connection.onNotification(msg);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });

  // Async stdin failures (EPIPE after the peer exits) must settle pending RPCs
  // immediately — swallowing the write leaves session/prompt hanging forever.
  child.stdin?.on("error", (error) => {
    failTransport(error instanceof Error ? error : new Error(String(error)));
  });

  child.on("error", (error) => {
    failTransport(error instanceof Error ? error : new Error(String(error)));
  });

  child.on("close", (code) => {
    closed = true;
    connection.rejectPending("process closed");
    try {
      connection.onClose(code, stderr);
    } catch {
      // ignore
    }
  });

  return connection;
}

export type AcpConnection = ReturnType<typeof acpConnection>;
