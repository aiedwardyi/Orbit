import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { TeamSection, type TeamView } from "./TeamSection";

const days = Array.from({ length: 14 }, (_, index) => new Date(Date.UTC(2026, 8, 30) + index * 86400000).toISOString().slice(0, 10));
const rows = (tail: [number, number][]) => [...Array.from({ length: 14 - tail.length }, () => ({ count: 0, minutes: 0 })), ...tail.map(([count, minutes]) => ({ count, minutes }))];

const view: TeamView = {
  now: Date.parse("2026-10-13T15:00:00Z"),
  days,
  people: [
    {
      id: "ada",
      name: "Ada",
      online: true,
      lastSeen: Date.parse("2026-10-13T15:00:00Z"),
      pcs: [
        { label: "aaaaaaaaaaaaaaaa", name: "Field", online: true },
        { label: "bbbbbbbbbbbbbbbb", name: "Studio", online: false },
      ],
      hours: [1, 2, 0, 3, 1.5, 4, 2, 0, 5, 1, 3, 2, 4, 6.9],
      phone: rows([[2, 100], [2, 100], [2, 100], [2, 100], [2, 100], [2, 100], [2, 100], [1, 5], [0, 0], [0, 0], [1, 10], [0, 0], [0, 0], [3, 4]]),
    },
    {
      id: "bea",
      name: "Bea",
      online: false,
      lastSeen: Date.parse("2026-10-13T12:00:00Z"),
      pcs: [{ label: "cccccccccccccccc", name: "Spare", online: false }],
      hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      phone: rows([[1, 30], [1, 65]]),
    },
    {
      id: "cy",
      name: "Cy",
      online: false,
      lastSeen: Date.parse("2026-10-12T09:00:00Z"),
      pcs: [{ label: "dddddddddddddddd", name: "Desk", online: false }],
      hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
      phone: rows([[2, 30], [0, 0]]),
    },
    {
      id: "dee",
      name: "Dee",
      online: false,
      lastSeen: Date.parse("2026-10-13T14:00:00Z"),
      pcs: [{ label: "eeeeeeeeeeeeeeee", name: "Lap", online: false }],
      hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      phone: rows([[1, 0]]),
    },
  ],
};

async function renderTeam(stats: TeamView = view) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(TeamSection, { stats }));
  });
  return host;
}

async function cardAt(index: number) {
  const card = (await renderTeam()).querySelectorAll("article")[index];
  if (!card) throw new Error(`no card ${index}`);
  return card;
}

async function tapBar(card: Element, index: number) {
  await act(async () => {
    (card.querySelectorAll("button")[index] as HTMLButtonElement).click();
  });
}

describe("team cards", () => {
  afterEach(() => {
    document.body.replaceChildren();
    applyLocale("en");
  });

  it("shows no device numbers, PC counts or averages", async () => {
    const host = await renderTeam();
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")).join(" ");
    const text = `${host.textContent} ${labels}`;
    expect(text).not.toMatch(/PC|Phone|avg/);
  });

  it("counts today's mobile visits on the card, singular for one", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("Mobile today · 3 visits · 4m");
    expect(cards[1]?.textContent).toContain("Mobile today · 1 visit · 1h 5m");
    expect(cards[1]?.textContent).not.toContain("1 visits");
  });

  it("says No mobile today with no visits", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[2]?.textContent).toContain("No mobile today");
    expect(cards[2]?.textContent).not.toContain("Mobile today");
  });

  it("counts a visit that runs past midnight on the next day too", async () => {
    const eve = { id: "eve", name: "Eve", online: true, lastSeen: view.now, pcs: [{ label: "ffffffffffffffff", name: "Lap", online: true }], hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], phone: rows([[1, 20], [0, 12]]) };
    const card = (await renderTeam({ ...view, people: [eve] })).querySelector("article");
    if (!card) throw new Error("no card");
    expect(card.textContent).toContain("Mobile today · 1 visit · 12m");
    await tapBar(card, 13);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Tue, Oct 13\n1h online\nMobile 1 visit · 12m");
  });

  it("shows <1m for a visit under a minute", async () => {
    const card = await cardAt(3);
    expect(card.textContent).toContain("Mobile today · 1 visit · <1m");
    await tapBar(card, 13);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Tue, Oct 13\n1h online\nMobile 1 visit · <1m");
  });

  it("uses a singular day only for one active day", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("12 days active");
    expect(cards[1]?.textContent).toContain("1 day active");
    expect(cards[1]?.textContent).not.toContain("1 days");
  });

  it("names the busiest day without a phone average", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("Busiest Tue, Oct 13 · 6.9h");
    expect(cards[1]?.textContent).toContain("Busiest Tue, Oct 13 · 0.5h");
  });

  it("tips with date, hours online, then mobile visits", async () => {
    const card = await cardAt(0);
    await tapBar(card, 13);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Tue, Oct 13\n6.9h online\nMobile 3 visits · 4m");
    await tapBar(card, 10);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Sat, Oct 10\n3h online\nMobile 1 visit · 10m");
    await tapBar(card, 8);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Thu, Oct 8\n5h online\nNo mobile");
  });

  it("follows the tip in the aria label", async () => {
    const card = await cardAt(0);
    expect(card.querySelectorAll("button")[13]?.getAttribute("aria-label")).toBe("Tue, Oct 13, 6.9h online, Mobile 3 visits · 4m");
  });

  it("keeps the status to last seen", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("Online");
    expect(cards[1]?.textContent).toContain("3h ago");
  });

  it("follows the header pattern in Korean", async () => {
    applyLocale("ko");
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("오늘 모바일 3회 · 4m");
    expect(cards[1]?.textContent).toContain("오늘 모바일 1회 · 1h 5m");
    expect(cards[2]?.textContent).toContain("오늘 모바일 없음");
    expect(cards[3]?.textContent).toContain("오늘 모바일 1회 · <1m");
    expect(cards[1]?.textContent).toContain("1일 활동");
  });

  it("tips mobile visits in Korean", async () => {
    applyLocale("ko");
    const card = await cardAt(0);
    await tapBar(card, 13);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toContain("모바일 3회 · 4m");
    await tapBar(card, 8);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toContain("모바일 없음");
  });
});
