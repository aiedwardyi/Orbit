// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** The Settings line "Get notified…" is a promise. Do not show it unless
 * this surface can actually deliver a toast. */
export function canClaimGetNotified(input: {
  toastsAvailable?: boolean;
  html5: boolean;
}): boolean {
  if (input.toastsAvailable === false) return false;
  if (input.toastsAvailable === true) return true;
  return input.html5;
}

export function desktopNotificationHint(canNotify: boolean): string {
  return canNotify
    ? "Get notified when this bot finishes or needs input"
    : "Desktop alerts aren't available on this computer";
}

/** The identity a notification groups under: one bot, wherever it was
 * working. Keyed by bot rather than thread so a single bot running across
 * tasks and rooms coalesces into one stack instead of stacking banners. */
export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

/** Presentation options for one bot's notifications: the stable per-bot
 * coalescing key platforms replace on (`tag`) and its avatar, when the
 * profile has one. Pure so the grouping rule stays testable on its own. */
export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

/** Show one unless the exact destination conversation is already visible.
 * A focused app may still be showing another task (routine runs are detached),
 * so window focus alone is not proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  const native = typeof window !== "undefined" ? window.ogb?.showNotification : undefined;
  if (typeof native === "function") {
    native({
      title: frame.title,
      body: frame.body,
      icon: avatarUrl ?? undefined,
      botId: frame.botId,
      threadId: frame.threadId,
      visibleThreadId: visibleThreadId ?? null,
    });
    return;
  }

  if (typeof Notification === "undefined") return;
  if (document.hasFocus() && visibleThreadId === frame.threadId) return;

  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
    };
    new Notification(frame.title, options).onclick = open;
  }
}
