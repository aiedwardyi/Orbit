export const TERMINAL_OPENED_KEY = "openmausbot.terminalOpened.v1";
export const PRESTART_DELAY_MS = 1_500;
// TerminalWorkspace's 13px font at 1.25 line height, inside its header and footer.
// A guess is enough: the panel resizes the shell when it is shown.
const CELL_WIDTH = 7.8;
const CELL_HEIGHT = 16.25;
const CHROME_WIDTH = 40;
const CHROME_HEIGHT = 90;
const OPENED_LIMIT = 200;

type PrestartBridge = { prestart?(input: { botId: string; cols: number; rows: number; projectCwd: string | null }): Promise<boolean> };

export function loadOpenedTerminals(storage?: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const parsed: unknown = JSON.parse(target?.getItem(TERMINAL_OPENED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => Object.prototype.toString.call(id) === "[object String]") : []);
  } catch {
    return new Set();
  }
}

export function rememberTerminalOpened(botId: string, storage?: Pick<Storage, "getItem" | "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    const opened = loadOpenedTerminals(target);
    if (opened.has(botId)) return;
    target?.setItem(TERMINAL_OPENED_KEY, JSON.stringify([...opened, botId].slice(-OPENED_LIMIT)));
  } catch {
    // A full or blocked store only costs the head start.
  }
}

export function prestartSize(width: number, height: number): { cols: number; rows: number } | null {
  const cols = Math.min(500, Math.floor((width - CHROME_WIDTH) / CELL_WIDTH));
  const rows = Math.min(300, Math.floor((height - CHROME_HEIGHT) / CELL_HEIGHT));
  return cols >= 2 && rows >= 1 ? { cols, rows } : null;
}

/** Pre-starts a bot's main shell once its chat has been open a moment; the host skips a bot that has one. */
export function schedulePrestart({
  bridge,
  botId,
  projectCwd,
  measure,
  storage,
}: {
  bridge: PrestartBridge | undefined;
  botId: string;
  projectCwd: string | null;
  measure: () => { width: number; height: number } | undefined;
  storage?: Pick<Storage, "getItem"> | null;
}): () => void {
  // No desktop bridge means a remote browser, which never starts shells on its own.
  if (!bridge?.prestart || !loadOpenedTerminals(storage).has(botId)) return () => {};
  const timer = setTimeout(() => {
    const box = measure();
    const size = box ? prestartSize(box.width, box.height) : null;
    if (size) void bridge.prestart?.({ botId, ...size, projectCwd }).catch(() => {});
  }, PRESTART_DELAY_MS);
  return () => clearTimeout(timer);
}
