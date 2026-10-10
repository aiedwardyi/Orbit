import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLD_OPEN_TIMEOUT_MS, createColdOpenTiming, withoutClickTime, type ColdOpenPage } from "./cold-open-timing";

const ORIGIN = 1_800_000_000_000;

const navigation = {
  fetchStart: 3.4,
  connectStart: 10,
  connectEnd: 120,
  secureConnectionStart: 40,
  requestStart: 121,
  responseStart: 300,
  responseEnd: 310,
  domInteractive: 900,
  domContentLoadedEventEnd: 950.6,
};

const paints = [
  { name: "first-paint", startTime: 700.2 },
  { name: "first-contentful-paint", startTime: 1400.7 },
];

const resources = [
  { name: "https://home.example/assets/index-DNyEQLOj.js", startTime: 320, responseEnd: 800, transferSize: 0, encodedBodySize: 376156 },
  { name: "https://home.example/assets/index-a1M9JH_P.css", startTime: 320, responseEnd: 500, transferSize: 29059, encodedBodySize: 28759 },
  { name: "https://home.example/api/bots?messages=200", startTime: 1600.4, responseEnd: 2400.5, transferSize: 285111, encodedBodySize: 284811 },
  { name: "https://home.example/api/bots/b1/tasks/t-new", startTime: 1500, responseEnd: 2600, transferSize: 900, encodedBodySize: 600 },
];

const USER_AGENT = "Mozilla/5.0 (Linux; Android 14; SM-S928N) SamsungBrowser/27.0";

function fakePage(href: string, navType: NavigationTimingType = "navigate", extra: { nav?: object; userAgent?: string } = {}) {
  const sent: any[] = [];
  const paintsQueued: Array<() => void> = [];
  let now = 0;
  let url = href;
  const page: ColdOpenPage = {
    href,
    timeOrigin: ORIGIN,
    now: () => now,
    navigation: () => ({ ...navigation, ...extra.nav, type: navType }),
    paints: () => paints,
    resources: () => resources,
    replaceUrl: (next) => (url = next),
    standalone: () => true,
    visibility: () => "visible",
    build: () => "index-DNyEQLOj.js",
    userAgent: extra.userAgent ?? USER_AGENT,
    afterPaint: (done) => paintsQueued.push(done),
    send: (body) => sent.push(JSON.parse(body)),
  };
  return {
    page,
    sent,
    url: () => url,
    at: (ms: number) => (now = ms),
    paint: () => paintsQueued.splice(0).forEach((done) => done()),
    expire: () => vi.advanceTimersByTime(COLD_OPEN_TIMEOUT_MS),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cold-open timing", () => {
  it("records a notification open from the tap to the target chat's paint", () => {
    const fake = fakePage("https://home.example/?bot=b1&thread=t-new&t0=1799999998000");
    const timing = createColdOpenTiming(fake.page);
    expect(fake.url()).toBe("/?bot=b1&thread=t-new");
    fake.at(1200.4);
    timing.mark("mount");
    fake.at(1500);
    timing.mark("sseOpen");
    fake.at(1590);
    timing.mark("hello");
    fake.at(1700);
    timing.mark("hello");
    timing.chatShown("t-old");
    fake.paint();
    expect(fake.sent).toEqual([]);
    timing.chatShown("t-new");
    timing.chatShown("t-new");
    fake.at(2700.6);
    fake.paint();
    fake.expire();
    expect(fake.sent).toEqual([
      {
        label: "notification",
        t0: -2000,
        nav: {
          fetchStart: 3,
          connectStart: 10,
          connectEnd: 120,
          secureConnectionStart: 40,
          requestStart: 121,
          responseStart: 300,
          responseEnd: 310,
          domInteractive: 900,
          domContentLoadedEventEnd: 951,
        },
        firstPaint: 700,
        firstContentfulPaint: 1401,
        mount: 1200,
        sseOpen: 1500,
        hello: 1590,
        bots: { start: 1600, end: 2401, transferSize: 285111, encodedBodySize: 284811 },
        taskSwitch: { start: 1500, end: 2600, transferSize: 900, encodedBodySize: 600 },
        chatPaint: 2701,
        jsCached: true,
        cssCached: false,
        navigationType: "navigate",
        displayMode: "standalone",
        visibility: "visible",
        build: "index-DNyEQLOj.js",
        userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S928N) SamsungBrowser/27.0",
      },
    ]);
  });

  it("labels a plain launch as open and takes whichever chat paints", () => {
    const fake = fakePage("https://home.example/");
    const timing = createColdOpenTiming(fake.page);
    expect(fake.url()).toBe("https://home.example/");
    timing.chatShown(undefined);
    timing.chatShown("t-any");
    fake.paint();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label: "open", navigationType: "navigate" });
    expect(fake.sent[0]).not.toHaveProperty("t0");
  });

  it("skips a reload with no tap", () => {
    const fake = fakePage("https://home.example/", "reload");
    const timing = createColdOpenTiming(fake.page);
    timing.chatShown("t-any");
    fake.paint();
    fake.expire();
    expect(fake.sent).toEqual([]);
  });

  it("sends what it reached after 30 s, once", () => {
    const fake = fakePage("https://home.example/?t0=1800000000500");
    const timing = createColdOpenTiming(fake.page);
    fake.at(900);
    timing.mark("mount");
    fake.expire();
    fake.expire();
    timing.chatShown("t-late");
    fake.paint();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label: "notification", t0: 500, mount: 900 });
    expect(fake.sent[0]).not.toHaveProperty("chatPaint");
    expect(fake.sent[0]).not.toHaveProperty("hello");
  });

  it("records a warm tap with its tap time and the target chat's paint only", () => {
    const fake = fakePage("https://home.example/", "reload");
    const timing = createColdOpenTiming(fake.page);
    timing.warm(Number(undefined), "t-new");
    timing.chatShown("t-new");
    fake.paint();
    expect(fake.sent).toEqual([]);
    fake.at(60_000);
    timing.warm(ORIGIN + 59_950, "t-new");
    timing.mark("hello");
    timing.chatShown("t-other");
    fake.paint();
    expect(fake.sent).toEqual([]);
    timing.chatShown("t-new");
    fake.at(60_210);
    fake.paint();
    expect(fake.sent).toEqual([
      {
        label: "warm",
        t0: 59_950,
        chatPaint: 60_210,
        displayMode: "standalone",
        visibility: "visible",
        build: "index-DNyEQLOj.js",
        userAgent: USER_AGENT,
      },
    ]);
  });

  it.each([
    { worker: "old", query: "?bot=b1&thread=t-new", label: "open" },
    { worker: "new", query: `?bot=b1&thread=t-new&t0=${ORIGIN - 100}`, label: "notification" },
  ])("waits for the target chat's delayed switch when an $worker worker opened it", ({ query, label }) => {
    const fake = fakePage(`https://home.example/${query}`);
    const timing = createColdOpenTiming(fake.page);
    fake.at(2100);
    timing.chatShown("t-other");
    fake.paint();
    expect(fake.sent).toEqual([]);
    fake.at(6000);
    timing.chatShown("t-new");
    fake.paint();
    fake.expire();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label, navigationType: "navigate", chatPaint: 6000 });
  });

  it("still takes any chat on a plain navigation whose address names no thread", () => {
    const fake = fakePage("https://home.example/?bot=b1");
    const timing = createColdOpenTiming(fake.page);
    timing.chatShown("t-other");
    fake.paint();
    expect(fake.sent).toHaveLength(1);
  });

  it("drops a pending open when a warm tap arrives and sends only the warm record", () => {
    const fake = fakePage("https://home.example/");
    const timing = createColdOpenTiming(fake.page);
    fake.at(59_000);
    timing.warm(ORIGIN + 58_900, "t-new");
    timing.chatShown("t-old");
    fake.paint();
    expect(fake.sent).toEqual([]);
    fake.at(59_400);
    timing.chatShown("t-new");
    fake.paint();
    fake.expire();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label: "warm", t0: 58_900, chatPaint: 59_400 });
  });

  it("lets a newer warm tap replace an older one", () => {
    const fake = fakePage("https://home.example/", "reload");
    const timing = createColdOpenTiming(fake.page);
    fake.at(60_000);
    timing.warm(ORIGIN + 59_900, "t-a");
    timing.warm(ORIGIN + 59_950, "t-b");
    timing.chatShown("t-a");
    fake.paint();
    expect(fake.sent).toEqual([]);
    timing.chatShown("t-b");
    fake.paint();
    fake.expire();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label: "warm", t0: 59_950 });
  });

  it("drops a measurement already waiting on its frame when a warm tap supersedes it", () => {
    const fake = fakePage("https://home.example/");
    const timing = createColdOpenTiming(fake.page);
    timing.chatShown("t-old");
    timing.warm(ORIGIN + 1, "t-new");
    fake.paint();
    expect(fake.sent).toEqual([]);
  });

  it("leaves a pending record alone for a tap with no usable time", () => {
    const fake = fakePage("https://home.example/");
    const timing = createColdOpenTiming(fake.page);
    timing.warm(Number(undefined), "t-new");
    timing.chatShown("t-old");
    fake.paint();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ label: "open" });
  });

  it("omits a navigation field the browser left undefined", () => {
    const fake = fakePage("https://home.example/", "navigate", { nav: { secureConnectionStart: undefined, domInteractive: Number.NaN } });
    const timing = createColdOpenTiming(fake.page);
    timing.chatShown("t1");
    fake.paint();
    expect(fake.sent[0].nav).not.toHaveProperty("secureConnectionStart");
    expect(fake.sent[0].nav).not.toHaveProperty("domInteractive");
    expect(fake.sent[0].nav).toMatchObject({ fetchStart: 3, responseEnd: 310 });
    expect(Object.values(fake.sent[0].nav)).not.toContain(null);
  });

  it("cuts the user agent to the server's limit", () => {
    const fake = fakePage("https://home.example/", "navigate", { userAgent: `Mozilla/5.0 ${"x".repeat(600)}` });
    const timing = createColdOpenTiming(fake.page);
    timing.chatShown("t1");
    fake.paint();
    expect(fake.sent[0].userAgent).toHaveLength(512);
    expect(fake.sent[0].userAgent.startsWith("Mozilla/5.0 xxx")).toBe(true);
  });

  it("keeps the rest of the address when it strips the tap time", () => {
    expect(withoutClickTime("https://home.example/?bot=b1&t0=5&thread=t1#x")).toBe("/?bot=b1&thread=t1#x");
    expect(withoutClickTime("https://home.example/?t0=5")).toBe("/");
    expect(withoutClickTime("https://home.example/?bot=b1&thread=t1")).toBeNull();
  });

  it("swallows a send that throws", () => {
    const fake = fakePage("https://home.example/");
    const timing = createColdOpenTiming({ ...fake.page, send: () => { throw new Error("offline"); } });
    timing.chatShown("t1");
    expect(() => fake.paint()).not.toThrow();
  });
});
