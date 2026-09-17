import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function spawnTerminalPty(modulePath, shell, args, options) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { modulePath, shell, args, options } });
  const dataListeners = new Set();
  const exitListeners = new Set();
  const errorListeners = new Set();
  const requests = new Map();
  let nextRequestId = 0;
  let exited = false;
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const errorValue = (value) => value instanceof Error ? value : new Error(String(value));
  const notifyError = (error) => {
    const cause = errorValue(error);
    for (const listener of errorListeners) {
      try { listener(cause); } catch {}
    }
    return cause;
  };
  const rejectRequests = (error) => {
    const cause = errorValue(error);
    for (const { reject } of requests.values()) reject(cause);
    requests.clear();
  };
  const finish = (exitCode) => {
    if (exited) return;
    exited = true;
    if (!ready) rejectReady(new Error("Terminal worker exited before ready"));
    rejectRequests(new Error("Terminal has exited"));
    for (const listener of exitListeners) listener({ exitCode });
  };
  const fail = (error, fatal = true) => {
    const cause = notifyError(error);
    if (fatal) {
      if (!ready) rejectReady(cause);
      finish(1);
    }
  };
  const request = (type, payload) => {
    if (exited) return Promise.reject(new Error("Terminal has exited"));
    const requestId = ++nextRequestId;
    return new Promise((resolve, reject) => {
      requests.set(requestId, { resolve, reject });
      try {
        worker.postMessage({ type, requestId, ...payload });
      } catch (error) {
        requests.delete(requestId);
        reject(error);
      }
    });
  };
  worker.on("message", (message) => {
    if (message.type === "ready") {
      ready = true;
      resolveReady();
    }
    if (message.type === "data") for (const listener of dataListeners) listener(message.data);
    if (message.type === "exit") {
      if (Number.isInteger(message.requestId)) {
        const pending = requests.get(message.requestId);
        if (pending) {
          requests.delete(message.requestId);
          pending.resolve();
        }
      }
      finish(message.exitCode);
    }
    if (message.type === "error") {
      const requestId = message.requestId;
      if (Number.isInteger(requestId) && requests.has(requestId)) {
        const pending = requests.get(requestId);
        requests.delete(requestId);
        pending.reject(new Error(message.message || "Terminal operation failed"));
      } else {
        fail(new Error(message.message || "Terminal worker failed"), message.fatal !== false);
      }
    }
    if (message.type === "ack" && Number.isInteger(message.requestId)) {
      const pending = requests.get(message.requestId);
      if (!pending) return;
      requests.delete(message.requestId);
      pending.resolve();
    }
  });
  worker.on("error", (error) => {
    fail(error);
  });
  worker.on("exit", (exitCode) => {
    if (exitCode !== 0 && !exited) fail(new Error(`Terminal worker exited (${exitCode})`));
    finish(exitCode);
  });
  return {
    onData: (listener) => dataListeners.add(listener),
    onExit: (listener) => exitListeners.add(listener),
    onError: (listener) => errorListeners.add(listener),
    ready: readyPromise,
    write: (data) => request("write", { data }),
    resize: (cols, rows) => request("resize", { cols, rows }),
    kill: () => request("kill", {}),
    terminate: () => worker.terminate(),
  };
}

if (!isMainThread && workerData?.modulePath) {
  try {
    const killRequests = new Set();
    const pty = require(workerData.modulePath).spawn(workerData.shell, workerData.args, workerData.options);
    pty.onData((data) => parentPort.postMessage({ type: "data", data }));
    pty.onExit(({ exitCode }) => {
      for (const requestId of killRequests) parentPort.postMessage({ type: "ack", requestId });
      parentPort.postMessage({ type: "exit", exitCode });
      // Exit this worker so ConPTY's reader cannot outlive the finished shell.
      process.exit(0);
    });
    parentPort.on("message", (message) => {
      try {
        if (message.type === "write") pty.write(message.data);
        if (message.type === "resize") pty.resize(message.cols, message.rows);
        if (message.type === "kill") {
          if (Number.isInteger(message.requestId)) killRequests.add(message.requestId);
          pty.kill();
        }
        if (message.type !== "kill" && Number.isInteger(message.requestId)) parentPort.postMessage({ type: "ack", requestId: message.requestId });
      } catch (error) {
        parentPort.postMessage({ type: "error", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
      }
    });
    parentPort.postMessage({ type: "ready" });
  } catch (error) {
    parentPort.postMessage({ type: "error", fatal: true, message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}
