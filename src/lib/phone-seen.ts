// A phone's Wink checks in while open, so this PC's Settings > Phone can list it.
export const PHONE_SEEN_PATH = "/api/phone-seen";
export const PHONE_SEEN_MS = 60_000;
// Off the cold-open path: the first load gets the connection to itself.
export const PHONE_SEEN_FIRST_MS = 5_000;
const KEY = "omb-phone-id";

function phoneId(): string | null {
  try {
    const id = localStorage.getItem(KEY) ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return null;
  }
}

export function startPhoneSeen(): void {
  if (window.ogb || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
  const id = phoneId();
  if (!id) return;
  const ping = () => {
    if (document.visibilityState === "hidden") return;
    void fetch(PHONE_SEEN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  };
  window.setTimeout(ping, PHONE_SEEN_FIRST_MS);
  document.addEventListener("visibilitychange", ping);
  window.setInterval(ping, PHONE_SEEN_MS);
}
