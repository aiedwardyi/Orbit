/** Copy key and vars for the close prompt, or null when nothing is running. */
export function closePrompt({ workers, botBusy }) {
  if (workers > 0 && botBusy) return { key: "close.both" };
  if (workers > 1) return { key: "close.workerMany", vars: { count: workers } };
  if (workers === 1) return { key: "close.workerOne" };
  if (botBusy) return { key: "close.bot" };
  return null;
}

const SESSION_END_WAIT_MS = 30_000;

/** Ask before the main window closes while work is running. macOS keeps the app alive on close, so it never asks. */
export function createCloseGuard({ platform, workerCount, botBusy, confirm, reveal }) {
  let leaving = false;
  let briefly = null;
  let asking = false;
  let confirmed = false;
  return {
    /** Deliberate quits (update install, start fresh, signals, shutdown) reach here via `before-quit` or session end. */
    leave() {
      // Final on purpose: a quit that reached here is never cancelled.
      leaving = true;
      clearTimeout(briefly);
      briefly = null;
    },
    /** Windows `query-session-end`: no cancel event exists, so the pause lapses unless `session-end` calls `leave`. */
    leaveBriefly() {
      if (leaving) return;
      clearTimeout(briefly);
      briefly = setTimeout(() => (briefly = null), SESSION_END_WAIT_MS);
      briefly.unref?.();
    },
    async handleClose(event, closeWindow) {
      if (platform === "darwin" || leaving || briefly) return "close";
      if (confirmed) {
        confirmed = false;
        return "close";
      }
      const prompt = closePrompt({ workers: workerCount(), botBusy: botBusy() });
      if (!prompt) return "close";
      event.preventDefault();
      if (asking) return "ignored";
      asking = true;
      try {
        reveal?.();
        if (!(await confirm(prompt))) return "keep";
        confirmed = true;
        closeWindow();
        return "close";
      } finally {
        asking = false;
      }
    },
  };
}
