import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function spawnTerminalPty(modulePath, shell, args, options) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { modulePath, shell, args, options } });
  const dataListeners = new Set();
  const exitListeners = new Set();
  let exited = false;
  const finish = (exitCode) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
  };
  worker.on("message", (message) => {
    if (message.type === "data") for (const listener of dataListeners) listener(message.data);
    if (message.type === "exit") finish(message.exitCode);
  });
  worker.on("error", (error) => {
    for (const listener of dataListeners) listener(`\r\n${error.message}\r\n`);
    finish(1);
  });
  worker.on("exit", finish);
  return {
    onData: (listener) => dataListeners.add(listener),
    onExit: (listener) => exitListeners.add(listener),
    write: (data) => worker.postMessage({ type: "write", data }),
    resize: (cols, rows) => worker.postMessage({ type: "resize", cols, rows }),
    kill: () => worker.postMessage({ type: "kill" }),
  };
}

if (!isMainThread && workerData?.modulePath) {
  const pty = require(workerData.modulePath).spawn(workerData.shell, workerData.args, workerData.options);
  pty.onData((data) => parentPort.postMessage({ type: "data", data }));
  pty.onExit(({ exitCode }) => {
    parentPort.postMessage({ type: "exit", exitCode });
    // Exit this worker so ConPTY's reader cannot outlive the finished shell.
    process.exit(0);
  });
  parentPort.on("message", (message) => {
    if (message.type === "write") pty.write(message.data);
    if (message.type === "resize") pty.resize(message.cols, message.rows);
    if (message.type === "kill") pty.kill();
  });
}
