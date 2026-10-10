// Where a phone page's open spends its time, from a notification tap or a plain launch.
export const COLD_OPEN_PATH = "/api/diag/cold-open";
export const COLD_OPEN_TIMEOUT_MS = 30_000;

export type ColdOpenLabel = "notification" | "open" | "warm";
export type ColdOpenMark = "mount" | "sseOpen" | "hello";

const NAV_FIELDS = [
  "fetchStart",
  "connectStart",
  "connectEnd",
  "secureConnectionStart",
  "requestStart",
  "responseStart",
  "responseEnd",
  "domInteractive",
  "domContentLoadedEventEnd",
] as const;

type NavField = (typeof NAV_FIELDS)[number];

export interface ColdOpenRequest {
  start: number;
  end: number;
  transferSize: number;
  encodedBodySize: number;
}

export interface ColdOpenRecord {
  label: ColdOpenLabel;
  t0?: number;
  nav?: Partial<Record<NavField, number>>;
  firstPaint?: number;
  firstContentfulPaint?: number;
  mount?: number;
  sseOpen?: number;
  hello?: number;
  bots?: ColdOpenRequest;
  taskSwitch?: ColdOpenRequest;
  chatPaint?: number;
  jsCached?: boolean;
  cssCached?: boolean;
  navigationType?: string;
  displayMode: "standalone" | "browser";
  visibility: string;
  build?: string;
  userAgent: string;
}

type Navigation = Pick<PerformanceNavigationTiming, NavField | "type">;
type Paint = Pick<PerformanceEntry, "name" | "startTime">;
type Resource = Pick<PerformanceResourceTiming, "name" | "startTime" | "responseEnd" | "transferSize" | "encodedBodySize">;

export interface ColdOpenPage {
  href: string;
  timeOrigin: number;
  now: () => number;
  navigation: () => Navigation | undefined;
  paints: () => readonly Paint[];
  resources: () => readonly Resource[];
  replaceUrl: (url: string) => void;
  standalone: () => boolean;
  visibility: () => string;
  build: () => string | undefined;
  userAgent: string;
  afterPaint: (done: () => void) => void;
  send: (body: string) => void;
}

interface Pending {
  label: ColdOpenLabel;
  t0?: number;
  threadId?: string;
  visibility: string;
  marks: Partial<Record<ColdOpenMark, number>>;
  painting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const BOTS = /\/api\/bots\?messages=/;
const TASK_SWITCH = /\/api\/(?:bots|groups)\/[^/]+\/tasks\/[^/?]+$/;
const ENTRY_JS = /\/assets\/index-[\w-]+\.js$/;
const ENTRY_CSS = /\/assets\/index-[\w-]+\.css$/;

/** The address without the notification's click time, or null when it has none. */
export function withoutClickTime(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("t0")) return null;
  url.searchParams.delete("t0");
  return url.pathname + url.search + url.hash;
}

function clickTime(at: number): number | undefined {
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

function request(entry: Resource | undefined): ColdOpenRequest | undefined {
  if (!entry) return undefined;
  return {
    start: Math.round(entry.startTime),
    end: Math.round(entry.responseEnd),
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
  };
}

function cached(entry: Resource | undefined): boolean | undefined {
  return entry ? entry.transferSize === 0 : undefined;
}

export function createColdOpenTiming(page: ColdOpenPage) {
  let pending: Pending | null = null;
  const navigation = page.navigation();

  const begin = (label: ColdOpenLabel, t0: number | undefined, threadId: string | undefined) => {
    const timer = setTimeout(() => finish(), COLD_OPEN_TIMEOUT_MS);
    pending = { label, t0, threadId, visibility: page.visibility(), marks: {}, painting: false, timer };
  };

  const record = (open: Pending, chatPaint: number | undefined): ColdOpenRecord => {
    const meta = {
      displayMode: page.standalone() ? ("standalone" as const) : ("browser" as const),
      visibility: open.visibility,
      build: page.build(),
      userAgent: page.userAgent,
    };
    const t0 = open.t0 === undefined ? undefined : Math.round(open.t0 - page.timeOrigin);
    if (open.label === "warm") return { label: "warm", t0, chatPaint, ...meta };
    const paint = (name: string) => {
      const at = page.paints().find((entry) => entry.name === name)?.startTime;
      return at === undefined ? undefined : Math.round(at);
    };
    const resources = page.resources();
    const path = (entry: Resource) => new URL(entry.name, page.href).pathname;
    const nav = navigation
      ? Object.fromEntries(NAV_FIELDS.map((field) => [field, Math.round(navigation[field])]))
      : undefined;
    return {
      label: open.label,
      t0,
      nav,
      firstPaint: paint("first-paint"),
      firstContentfulPaint: paint("first-contentful-paint"),
      ...open.marks,
      bots: request(resources.find((entry) => BOTS.test(entry.name))),
      taskSwitch: request(resources.find((entry) => TASK_SWITCH.test(path(entry)))),
      chatPaint,
      jsCached: cached(resources.find((entry) => ENTRY_JS.test(path(entry)))),
      cssCached: cached(resources.find((entry) => ENTRY_CSS.test(path(entry)))),
      navigationType: navigation?.type,
      ...meta,
    };
  };

  const finish = (chatPaint?: number) => {
    const open = pending;
    if (!open) return;
    pending = null;
    clearTimeout(open.timer);
    try {
      page.send(JSON.stringify(record(open, chatPaint)));
    } catch {
      // Timing is best effort; it never surfaces.
    }
  };

  const search = new URL(page.href).searchParams;
  const t0 = clickTime(Number(search.get("t0")));
  const stripped = withoutClickTime(page.href);
  if (stripped !== null) page.replaceUrl(stripped);
  if (t0 !== undefined) begin("notification", t0, search.get("thread") ?? undefined);
  else if (navigation?.type === "navigate") begin("open", undefined, undefined);

  return {
    mark(name: ColdOpenMark) {
      if (!pending || pending.label === "warm" || pending.marks[name] !== undefined) return;
      pending.marks[name] = Math.round(page.now());
    },
    /** The thread whose fresh messages are on screen, if any. */
    chatShown(threadId: string | undefined) {
      if (!pending || pending.painting || !threadId) return;
      if (pending.threadId && pending.threadId !== threadId) return;
      pending.painting = true;
      const open = pending;
      page.afterPaint(() => {
        if (pending === open) finish(Math.round(page.now()));
      });
    },
    warm(t0: number, threadId: string) {
      const at = clickTime(t0);
      if (pending || at === undefined) return;
      begin("warm", at, threadId);
    },
  };
}

type ColdOpenTiming = ReturnType<typeof createColdOpenTiming>;

let active: ColdOpenTiming | null = null;

function browserPage(): ColdOpenPage {
  return {
    href: window.location.href,
    timeOrigin: performance.timeOrigin,
    now: () => performance.now(),
    navigation: () => performance.getEntriesByType("navigation").find((entry) => entry instanceof PerformanceNavigationTiming),
    paints: () => performance.getEntriesByType("paint"),
    resources: () => performance.getEntriesByType("resource").filter((entry) => entry instanceof PerformanceResourceTiming),
    replaceUrl: (url) => window.history.replaceState(window.history.state, "", url),
    standalone: () => window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    visibility: () => document.visibilityState,
    build: () =>
      document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute("src")?.split("/").pop(),
    userAgent: navigator.userAgent,
    afterPaint: (done) => requestAnimationFrame(() => setTimeout(done, 0)),
    send: (body) => {
      void fetch(COLD_OPEN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    },
  };
}

/** Phone and browser pages only; the desktop app has no tap to time. */
export function startColdOpenTiming() {
  if (window.ogb || active) return;
  active = createColdOpenTiming(browserPage());
}

export function markColdOpen(name: ColdOpenMark) {
  active?.mark(name);
}

export function noteChatShown(threadId: string | undefined) {
  active?.chatShown(threadId);
}

export function startWarmOpenTiming(t0: number, threadId: string) {
  active?.warm(t0, threadId);
}
