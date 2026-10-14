import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { TeamSection, type TeamView } from "./TeamSection";

const days = Array.from({ length: 14 }, (_, index) => new Date(Date.UTC(2026, 8, 30) + index * 86400000).toISOString().slice(0, 10));
const rows = (minutes: number[]) => minutes.map((value) => ({ count: value ? 77 : 0, minutes: value }));

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
      phone: rows([100, 100, 100, 100, 100, 100, 100, 5, 0, 0, 10, 0, 0, 4]),
    },
    {
      id: "bea",
      name: "Bea",
      online: false,
      lastSeen: Date.parse("2026-10-13T12:00:00Z"),
      pcs: [{ label: "cccccccccccccccc", name: "Spare", online: false }],
      hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      phone: rows([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 35]),
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

  it("shows no phone counts, PC counts or averages", async () => {
    const host = await renderTeam();
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")).join(" ");
    const text = `${host.textContent} ${labels}`;
    expect(text).not.toMatch(/PC|Phone|avg|77/);
  });

  it("sums mobile minutes over the last 7 days", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("Mobile 19m in 7 days");
    expect(cards[1]?.textContent).toContain("Mobile 1h 5m in 7 days");
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

  it("tips with date, hours online, then mobile time", async () => {
    const card = (await renderTeam()).querySelector("article") as Element;
    await tapBar(card, 13);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Tue, Oct 13\n6.9h online\nMobile 4m");
    await tapBar(card, 8);
    expect(card.querySelector("p.whitespace-pre-line")?.textContent).toBe("Thu, Oct 8\n5h online\nMobile 0m");
  });

  it("keeps the status to last seen", async () => {
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("Online");
    expect(cards[1]?.textContent).toContain("3h ago");
  });

  it("follows the header pattern in Korean", async () => {
    applyLocale("ko");
    const cards = (await renderTeam()).querySelectorAll("article");
    expect(cards[0]?.textContent).toContain("모바일 7일 19m");
    expect(cards[1]?.textContent).toContain("1일 활동");
  });
});
