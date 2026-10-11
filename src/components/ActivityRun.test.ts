import "./ProfileFields.test-dom.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

import { ActivityRun, ActivityStep } from "./ActivityRun";

function step(name: string, summary: string | undefined, ok: boolean, durationMs: number): Message {
  const tool: NonNullable<Message["tool"]> = { name, ok, durationMs };
  if (summary) tool.summary = summary;
  return { id: `s-${name}`, role: "bot", kind: "activity", at: 1, tool };
}

function render(skin: string, element: ReturnType<typeof createElement>) {
  applyLocale("en");
  document.documentElement.dataset.skin = skin;
  return renderToStaticMarkup(element);
}

afterEach(() => {
  delete document.documentElement.dataset.skin;
});

describe("ActivityStep in the Terminal skin", () => {
  it("draws the Claude Code verb over one result line", () => {
    const html = render("terminal", createElement(ActivityStep, { message: step("Edit", "src/a.ts +2 -1", true, 1200) }));
    expect(html).toContain(">Update</span>(src/a.ts +2 -1)");
    expect(html).toContain("Done (1.2s)");
    expect(html).toContain("Update src/a.ts +2 -1, done, 1.2 seconds");
  });

  it("falls back to the bare name and Failed", () => {
    const html = render("terminal", createElement(ActivityStep, { message: step("browser_click", undefined, false, 400) }));
    expect(html).toContain(">browser_click</span></div>");
    expect(html).toContain("Failed (0.4s)");
  });

  it("leaves other skins on the chip row", () => {
    const html = render("tui", createElement(ActivityStep, { message: step("Edit", "src/a.ts", true, 1200) }));
    expect(html).not.toContain("term-step");
    expect(html).toContain(">Edit</span>");
  });
});

describe("ActivityRun in the Terminal skin", () => {
  it("names a search stretch the way Claude Code does", () => {
    const html = render("terminal", createElement(ActivityRun, { messages: [step("Grep", "x", true, 800), step("Read", "a.ts", true, 300)], children: null }));
    expect(html).toContain("Searched for 1 pattern, read 1 file");
    expect(html).not.toContain("2 steps");
  });
});
