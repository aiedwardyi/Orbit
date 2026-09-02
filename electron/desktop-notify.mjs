// Windows toast + taskbar helpers. Kept Electron-free so the AUMID, focus
// gate, and busy indicator stay unit-testable with plain fakes.

export const WINDOWS_APP_USER_MODEL_ID = "com.orbit.agentdesk";

export function windowsAppUserModelId() {
  return WINDOWS_APP_USER_MODEL_ID;
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
  return {
    title,
    body: typeof payload.body === "string" ? payload.body : "",
    icon: typeof payload.icon === "string" ? payload.icon : undefined,
    botId,
    threadId,
    visibleThreadId: payload.visibleThreadId == null ? null : asString(payload.visibleThreadId),
  };
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
    sendClick?.({ botId: parsed.botId, threadId: parsed.threadId });
  });
  notice.show();
  return { shown: true };
}
