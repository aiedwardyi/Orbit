// Phone notifications over Web Push, for Orbit opened in a phone browser (never the desktop app).
import { api } from "@/state/store";
import type { NotificationTarget } from "./notify";

export type WebPushState = "unsupported" | "off" | "on" | "blocked";

export function webPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !window.ogb &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function readWebPushState(): Promise<WebPushState> {
  if (!webPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

/** Call straight from the tap: the permission prompt needs the user gesture. */
export async function enableWebPush(): Promise<WebPushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const { publicKey }: { publicKey: string } = await api("/api/web-push");
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(publicKey) }));
  await api("/api/web-push/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
  return "on";
}

export async function disableWebPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/api/web-push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

export async function testWebPush(botId?: string): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error("This device is not subscribed");
  await api("/api/web-push/test", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint, botId }) });
}

/** The bot/thread a push notification opens, from its `/?bot=&thread=` url. */
export function webPushTarget(search: string): NotificationTarget | null {
  const params = new URLSearchParams(search);
  const botId = params.get("bot");
  const threadId = params.get("thread");
  return botId && threadId ? { botId, threadId } : null;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
