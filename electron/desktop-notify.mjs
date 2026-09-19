// Windows toast + taskbar helpers. Kept Electron-free so the AUMID, focus
// gate, and busy indicator stay unit-testable with plain fakes.

export const WINDOWS_APP_USER_MODEL_ID = "com.orbit.agentdesk";
export const DEV_WINDOWS_APP_USER_MODEL_ID = "com.orbit.agentdesk.dev";

export function windowsAppUserModelId(packagedOrOptions = true) {
  const packaged =
    typeof packagedOrOptions === "object" && packagedOrOptions !== null
      ? (packagedOrOptions.packaged ?? true)
      : packagedOrOptions !== false;
  return packaged ? WINDOWS_APP_USER_MODEL_ID : DEV_WINDOWS_APP_USER_MODEL_ID;
}

/** Minimized counts as background: Win10 renderer `document.hasFocus()` can
 * stay true after minimize and would otherwise swallow the toast. */
export function shouldShowDesktopToast({ focused, minimized, visibleThreadId, frameThreadId }) {
  const attentive = focused === true && minimized !== true;
  return !(attentive && visibleThreadId === frameThreadId);
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

export function parseNotifyPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const title = asString(payload.title);
  const botId = asString(payload.botId);
  const threadId = asString(payload.threadId);
  if (!title || !botId || !threadId) return null;
  const result = {
    title,
    body: typeof payload.body === "string" ? payload.body : "",
    icon: typeof payload.icon === "string" ? payload.icon : undefined,
    botId,
    threadId,
    visibleThreadId: payload.visibleThreadId == null ? null : asString(payload.visibleThreadId),
  };
  if (payload.openTerminal === true) result.openTerminal = true;
  const terminalSessionId = asString(payload.terminalSessionId);
  if (terminalSessionId) result.terminalSessionId = terminalSessionId;
  return result;
}

function notifyTargetFromParts({ botId, threadId, openTerminal, terminalSessionId }) {
  const bot = asString(botId);
  const thread = asString(threadId);
  if (!bot || !thread) return null;
  const target = { botId: bot, threadId: thread };
  if (openTerminal === true || openTerminal === "1" || openTerminal === "true") target.openTerminal = true;
  const session = asString(terminalSessionId);
  if (session) target.terminalSessionId = session;
  return target;
}

function notifyTargetFromDeepLink(value) {
  let link;
  try {
    link = new URL(String(value));
  } catch {
    return null;
  }
  if (link.protocol !== "orbit:" || link.hostname !== "notify") return null;
  return notifyTargetFromParts({
    botId: link.searchParams.get("botId"),
    threadId: link.searchParams.get("threadId"),
    openTerminal: link.searchParams.get("openTerminal"),
    terminalSessionId: link.searchParams.get("terminalSessionId"),
  });
}

/** Toast activation that lands as a second launch carries the bot/thread
 * as flags or an orbit://notify link. Null when the launch is not one. */
export function parseNotificationTargetFromCommandLine(argv) {
  if (!Array.isArray(argv)) return null;
  let botId = null;
  let threadId = null;
  let openTerminal = false;
  let terminalSessionId = null;
  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i]);
    const flag = value.match(/^--orbit-notify-(bot|thread|open-terminal|terminal-session)(?:=(.*))?$/);
    if (flag) {
      if (flag[1] === "bot") {
        const raw = flag[2] !== undefined ? flag[2] : String(argv[++i] ?? "");
        if (raw && !raw.startsWith("--")) botId = raw;
      } else if (flag[1] === "thread") {
        const raw = flag[2] !== undefined ? flag[2] : String(argv[++i] ?? "");
        if (raw && !raw.startsWith("--")) threadId = raw;
      } else if (flag[1] === "open-terminal") {
        openTerminal = flag[2] === undefined || flag[2] === "" || flag[2] === "1" || flag[2] === "true";
      } else if (flag[1] === "terminal-session") {
        const raw = flag[2] !== undefined ? flag[2] : String(argv[++i] ?? "");
        if (raw && !raw.startsWith("--")) terminalSessionId = raw;
      }
      continue;
    }
    const deep = notifyTargetFromDeepLink(value);
    if (deep) return deep;
  }
  if (!botId || !threadId) return null;
  return notifyTargetFromParts({ botId, threadId, openTerminal, terminalSessionId });
}

export function taskbarBusyIndicator(busy) {
  return busy === true
    ? { progress: 0, mode: "indeterminate" }
    : { progress: -1, mode: "none" };
}

export function canClaimDesktopToasts({ nativeSupported, html5Available, html5Permission } = {}) {
  if (nativeSupported === true) return true;
  if (html5Available !== true) return false;
  return html5Permission !== "denied";
}

export function withToastCapability(capabilities, nativeSupported) {
  return { ...capabilities, toasts: { available: nativeSupported === true } };
}

export function handleDesktopNotify({
  win,
  payload,
  Notification,
  nativeSupported,
  icon,
  activate,
  sendClick,
}) {
  const parsed = parseNotifyPayload(payload);
  if (!parsed || !win || win.isDestroyed()) return { shown: false };
  if (
    !shouldShowDesktopToast({
      focused: win.isFocused(),
      minimized: win.isMinimized(),
      visibleThreadId: parsed.visibleThreadId,
      frameThreadId: parsed.threadId,
    })
  ) {
    return { shown: false };
  }
  if (nativeSupported !== true || typeof Notification !== "function") return { shown: false };

  const notice = new Notification({
    title: parsed.title,
    body: parsed.body,
    silent: false,
    icon,
  });
  notice.on("click", () => {
    activate?.(win);
    const target = {
      botId: parsed.botId,
      threadId: parsed.threadId,
    };
    if (parsed.openTerminal) target.openTerminal = true;
    if (parsed.terminalSessionId) target.terminalSessionId = parsed.terminalSessionId;
    sendClick?.(target);
  });
  notice.show();
  return { shown: true };
}
