// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { ko } from "@/lib/i18n-catalog";
import { QuorumRow } from "./QuorumRow";

const NOW = Date.parse("2026-10-17T03:00:00Z");
const DAYS = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 9, 11 + index)).toISOString().slice(0, 10));

function day(index: number, costCents: number, visitors: number, signups: number, costByProvider = {}) {
  return { day: DAYS[index]!, costCents, costByProvider, visitors, signups };
}

interface Stats {
  days: ReturnType<typeof day>[];
  budget: { dailyCapCents: number; todayCountedCents: number } | null;
  tracking: { costSince: string | null; visitorsSince: string | null };
  users: number;
}

function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    days: [
      day(0, 100, 4, 0),
      day(1, 50, 2, 1),
      day(2, 0, 0, 0),
      day(3, 20, 6, 0),
      day(4, 10, 1, 2),
      day(5, 0.4, 3, 0),
      day(6, 52.31, 5, 1, { claude: 20.12, gpt: 8.2, gemini: 11.99, perplexity: 10, search: 2 }),
    ],
    budget: { dailyCapCents: 4000, todayCountedCents: 1230 },
    tracking: { costSince: DAYS[0]!, visitorsSince: DAYS[0]! },
    users: 4,
    ...overrides,
  };
}

const ok = (body = stats(), fetchedAt = NOW) => ({ state: "ok", stats: body, fetchedAt, now: fetchedAt });

let host: HTMLDivElement;
let root: Root;
let replies: (() => { state: string; stats?: Stats; fetchedAt?: number; now?: number } | Error)[];

function calls() {
  return vi.mocked(fetch).mock.calls.filter((call) => call[0] === "/api/quorum").length;
}

async function mount() {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(QuorumRow))));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function numbers() {
  return [...host.querySelectorAll("section .tabular-nums")];
}

function bars(cell: number) {
  return [...(numbers()[cell]?.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
}

function bigNumbers() {
  return numbers().map((number) => number.textContent);
}

function labels() {
  return numbers().map((number) => number.parentElement?.nextElementSibling?.textContent);
}

async function tap(button: HTMLButtonElement) {
  await act(async () => button.click());
}

describe("quorum row", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    replies = [() => ok()];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path !== "/api/quorum") return Response.json({ error: "no route" }, { status: 404 });
      const next = replies.length > 1 ? replies.shift()! : replies[0]!;
      const body = next();
      if (body instanceof Error) throw body;
      return Response.json(body);
    }));
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    applyLocale("en");
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the title and three totals with no today, range or account words", async () => {
    await mount();
    const card = host.querySelector("section > div");
    expect(card?.querySelector("a")?.textContent).toBe("Quorum");
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("https://heyquorum.com");
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    expect(labels()).toEqual(["spent", "visits", "sign-ups"]);
    expect(host.textContent).toBe("Quorum$2.33spent21visits4sign-ups");
    expect([0, 1, 2].map((cell) => bars(cell).length)).toEqual([7, 7, 0]);
  });

  it("draws a baseline for untracked days and bars above zero", async () => {
    replies = [() => ok(stats({ tracking: { costSince: DAYS[3]!, visitorsSince: null } }))];
    await mount();
    expect(bars(0).map((button) => button.querySelector("span") === null)).toEqual([false, false, false, false, false, false, false]);
    expect(bars(0)[2]!.querySelector("span")!.className).toContain("bg-ink-secondary/50");
    expect(bars(0)[2]!.getAttribute("aria-label")).toBe("Tue, Oct 13 · not tracked yet");
    expect(bars(1).map((button) => button.querySelector("span")!.className)).toEqual(Array(7).fill(expect.stringContaining("bg-ink-secondary/50")));
    expect(bigNumbers()).toEqual(["$0.83", "-", "4"]);
    expect(bars(0)[3]!.querySelector("span")!.className).toContain("bg-accent");
  });

  it("draws zero as a baseline and the rest as accent bars", async () => {
    replies = [() => ok(stats({ days: [day(0, 0, 0, 0), day(1, 50, 2, 1), day(2, 0, 0, 0), day(3, 0, 0, 0), day(4, 0, 0, 0), day(5, 0, 0, 0), day(6, 0, 0, 0)] }))];
    await mount();
    expect(bars(0)[0]!.querySelector("span")!.className).toContain("bg-ink-secondary/50");
    expect(bars(0)[1]!.querySelector("span")!.className).toContain("bg-accent");
  });

  it("leaves a day before tracking began out of the total", async () => {
    replies = [() => ok(stats({ tracking: { costSince: DAYS[5]!, visitorsSince: DAYS[6]! } }))];
    await mount();
    expect(bigNumbers()).toEqual(["$0.53", "5", "4"]);
  });

  it("formats small money", async () => {
    replies = [() => ok(stats({ days: [day(0, 0, 0, 0), day(1, 0, 0, 0), day(2, 0, 0, 0), day(3, 0, 0, 0), day(4, 0, 0, 0), day(5, 0, 0, 0), day(6, 0.3, 0, 0)] }))];
    await mount();
    expect(bigNumbers()[0]).toBe("<$0.01");
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => ok(stats({ days: DAYS.map((_, index) => day(index, 0, 0, 0)) }))];
    await mount();
    expect(bigNumbers()[0]).toBe("$0");
  });

  it("shows the cap from 75% in warning and at 100% in danger, never below", async () => {
    const cases: [number, string | null, string | null][] = [
      [1480, null, null],
      [1500, " · cap 75%", "text-warning"],
      [1640, " · cap 82%", "text-warning"],
      [1999, " · cap 99%", "text-warning"],
      [2000, " · cap hit", "text-danger"],
      [4500, " · cap hit", "text-danger"],
    ];
    for (const [counted, text, color] of cases) {
      root = createRoot(host);
      replies = [() => ok(stats({ budget: { dailyCapCents: 2000, todayCountedCents: counted } }))];
      await mount();
      const cap = host.querySelector(".text-warning, .text-danger");
      if (text === null) {
        expect(cap).toBeNull();
        expect(labels()[0]).toBe("spent");
      } else {
        expect(cap?.textContent).toBe(text);
        expect(cap?.className).toBe(color);
        expect(labels()[0]).toBe(`spent${text}`);
      }
      await act(async () => root.unmount());
    }
    root = createRoot(host);
  });

  it("explains the reset on cap hit and hides the cap when none is set", async () => {
    replies = [() => ok(stats({ budget: { dailyCapCents: 100, todayCountedCents: 100 } }))];
    await mount();
    expect(host.querySelector(".text-danger")?.getAttribute("title")).toMatch(/^Resets at /);
    await act(async () => root.unmount());
    root = createRoot(host);
    for (const budget of [{ dailyCapCents: 0, todayCountedCents: 500 }, null]) {
      replies = [() => ok(stats({ budget }))];
      await mount();
      expect(host.querySelector(".text-danger, .text-warning")).toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  it("opens one tip line per bar, with the provider split on spend and none on sign-ups", async () => {
    await mount();
    await tap(bars(0)[6]!);
    const tip = () => host.querySelector("section > p.whitespace-pre-line")?.textContent;
    expect(tip()).toBe("Sat, Oct 17 · $0.52\nClaude $0.20 · GPT $0.08 · Gemini $0.12 · Perplexity $0.10 · Search $0.02\nEstimated from token usage");
    await tap(bars(1)[6]!);
    expect(tip()).toBe("Sat, Oct 17 · 5 visitors");
    await tap(bars(1)[0]!);
    expect(tip()).toBe("Sun, Oct 11 · 4 visitors");
    expect(bars(1)[6]!.getAttribute("aria-label")).toBe("Sat, Oct 17 · 5 visitors");
    expect(host.querySelector("section")?.contains(numbers()[2]!.parentElement!.querySelector("button"))).toBe(false);
  });

  it("gives way to one line for each state, keeping the title", async () => {
    const text = () => host.textContent;
    replies = [() => ({ state: "notEnabled" })];
    await mount();
    expect(text()).toBe("QuorumQuorum stats aren't on yet");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => ({ state: "denied" })];
    await mount();
    expect(text()).toBe("QuorumQuorum token doesn't match");
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => ({ state: "error", now: NOW })];
    await mount();
    expect(text()).toBe("QuorumCan't reach Quorum right now");
  });

  it("renders nothing for off, for an old server's 404, and before the first reply", async () => {
    replies = [() => ({ state: "off" })];
    await mount();
    expect(host.innerHTML).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "not found" }, { status: 404 }));
    await mount();
    expect(host.innerHTML).toBe("");
  });

  it("dims kept data and says its age when a refresh fails", async () => {
    replies = [() => ok(), () => new Error("offline"), () => ({ state: "error", now: NOW + 5 * 60_000 * 3 })];
    await mount();
    expect(host.textContent).not.toContain("updated");
    expect(host.querySelector(".opacity-60")).toBeNull();
    await tick(5 * 60_000);
    expect(host.querySelector("section a")?.nextElementSibling?.textContent).toBe("updated 5 min ago");
    expect(host.querySelector(".opacity-60")).not.toBeNull();
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    await tick(10 * 60_000);
    expect(host.textContent).toContain("updated 15 min ago");
  });

  it("uses the server's kept data and clock for the age", async () => {
    replies = [() => ({ state: "error", now: NOW, stats: stats(), fetchedAt: NOW - 12 * 60_000 })];
    await mount();
    expect(host.querySelector("section a")?.nextElementSibling?.textContent).toBe("updated 12 min ago");
    expect(bigNumbers()[1]).toBe("21");
    expect(host.querySelector(".opacity-60")).not.toBeNull();
  });

  it("goes back to normal once a refresh works", async () => {
    replies = [() => ({ state: "error", now: NOW, stats: stats(), fetchedAt: NOW - 3 * 60_000 }), () => ok(stats(), NOW + 5 * 60_000)];
    await mount();
    expect(host.querySelector(".opacity-60")).not.toBeNull();
    await tick(5 * 60_000);
    expect(host.querySelector(".opacity-60")).toBeNull();
    expect(host.textContent).not.toContain("updated");
  });

  it("refreshes every five minutes, one at a time, and stops on unmount", async () => {
    await mount();
    expect(calls()).toBe(1);
    await tick(4 * 60_000);
    expect(calls()).toBe(1);
    await tick(60_000);
    expect(calls()).toBe(2);
    await tick(5 * 60_000);
    expect(calls()).toBe(3);
    await act(async () => root.unmount());
    await tick(30 * 60_000);
    expect(calls()).toBe(3);
    root = createRoot(host);
  });

  it("does not start a second request while one is in flight", async () => {
    let release: (value: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    await mount();
    await tick(15 * 60_000);
    expect(calls()).toBe(1);
    await act(async () => release(Response.json(ok())));
    await tick(5 * 60_000);
    expect(calls()).toBe(2);
    await act(async () => release(Response.json(ok())));
  });

  it("reads in Korean with every string present", async () => {
    localStorage.setItem("omb-locale", "ko");
    replies = [() => ok(stats({ budget: { dailyCapCents: 100, todayCountedCents: 80 } }))];
    await mount();
    expect(host.textContent).toBe("쿼럼$2.33지출 · 한도 80%21방문4가입");
    expect(host.textContent).not.toMatch(/오늘|최근|7일|전체/);
    await tap(bars(1)[6]!);
    expect(host.querySelector("section > p.whitespace-pre-line")?.textContent).toBe("토, 10월 17일 · 방문자 5명");
    await tap(bars(0)[6]!);
    expect(host.querySelector("section > p.whitespace-pre-line")?.textContent).toContain("Claude $0.20 · GPT $0.08 · Gemini $0.12 · Perplexity $0.10 · 검색 $0.02");
    const strings = Object.entries(ko).filter(([key]) => key.startsWith("quorum."));
    expect(strings).toHaveLength(18);
    for (const [, phrase] of strings) expect(phrase).not.toMatch(/^[\x20-\x7e]*$/u);
  });

  it("paints the kept row at once while the refresh is still out", async () => {
    await mount();
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    await act(async () => root.unmount());
    root = createRoot(host);
    let release!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    await mount();
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    await act(async () => release(Response.json(ok())));
    await act(async () => root.unmount());
    vi.resetModules();
    const fresh = await import("./QuorumRow");
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(fresh.QuorumRow))));
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
  });

  it("keeps the kept paint when the first refresh fails", async () => {
    await mount();
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => new Error("offline")];
    await mount();
    expect(bigNumbers()).toEqual(["$2.33", "21", "4"]);
    expect(host.querySelector(".opacity-60")).not.toBeNull();
    expect(host.textContent).toContain("updated 1 min ago");
  });

  it.each(["off", "denied", "notEnabled"])("clears persisted stats after %s and does not repaint them on remount", async (state) => {
    await mount();
    expect(localStorage.getItem("omb-quorum-kept")).not.toBeNull();
    replies = [() => ({ state })];
    await tick(5 * 60_000);
    expect(localStorage.getItem("omb-quorum-kept")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => new Error("offline")];
    await mount();
    expect(bigNumbers()).toEqual([]);
  });

  it("drops the kept paint when the first reply is off", async () => {
    await mount();
    expect(host.querySelector("section")).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    replies = [() => ({ state: "off" })];
    await mount();
    expect(host.innerHTML).toBe("");
  });
});
