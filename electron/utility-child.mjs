export const UTILITY_SHUTDOWN_TYPE = "openmausbot:shutdown";

export function isUtilityShutdownMessage(message) {
  return Boolean(
    message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      message.type === UTILITY_SHUTDOWN_TYPE,
  );
}

/** Ask an Electron utilityProcess to stop so its own SIGTERM-equivalent
 * cleanup (disposeAll / killCliTree) can run. Windows `kill()` is
 * TerminateProcess and skips that path; postMessage is the portable stop. */
export function stopUtilityChild(child, { timeoutMs = 2500 } = {}) {
  if (!child) return Promise.resolve("absent");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.("exit", onExit);
      resolve(reason);
    };
    const onExit = () => finish("exited");
    child.once?.("exit", onExit);

    let timer;
    try {
      child.postMessage({ type: UTILITY_SHUTDOWN_TYPE });
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish("forced");
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish("forced");
    }, timeoutMs);
  });
}
