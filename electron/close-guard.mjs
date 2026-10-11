/** Copy key and vars for the close prompt, or null when nothing is running. */
export function closePrompt({ workers, botBusy }) {
  if (workers > 0 && botBusy) return { key: "close.both" };
  if (workers > 1) return { key: "close.workerMany", vars: { count: workers } };
  if (workers === 1) return { key: "close.workerOne" };
  if (botBusy) return { key: "close.bot" };
  return null;
}

/** Ask before the main window closes while work is running. macOS keeps the app alive on close, so it never asks. */
export function createCloseGuard({ platform, workerCount, botBusy, confirm }) {
  let leaving = false;
  let asking = false;
  let confirmed = false;
  return {
    /** Deliberate quits (update install, start fresh, signals, shutdown) reach here via `before-quit` or session end. */
    leave() {
      leaving = true;
    },
    async handleClose(event, closeWindow) {
      if (platform === "darwin" || leaving) return "close";
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
