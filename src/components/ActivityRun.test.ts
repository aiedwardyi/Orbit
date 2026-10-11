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

  it("speaks the result line in Korean", () => {
    document.documentElement.dataset.skin = "terminal";
    applyLocale("ko");
    const html = renderToStaticMarkup(createElement(ActivityStep, { message: step("Edit", "src/a.ts", true, 1200) }));
    expect(html).toContain("완료 (1.2s)");
    expect(html).not.toContain("Done");
    const failed = renderToStaticMarkup(createElement(ActivityStep, { message: step("Edit", "src/a.ts", false, 400) }));
    expect(failed).toContain("실패 (0.4s)");
  });

  it("leaves other skins on the chip row", () => {
    const html = render("tui", createElement(ActivityStep, { message: step("Edit", "src/a.ts", true, 1200) }));
    expect(html).not.toContain("term-step");
    expect(html).toContain(">Edit</span>");
  });
});

describe("ActivityRun in the Terminal skin", () => {
  it.each([undefined, false])("keeps a folded search's %s verdict visible and accessible", (ok) => {
    const message = step("Read", "a.ts", true, 300);
    message.tool!.ok = ok;
    const host = document.createElement("div");
    host.innerHTML = render("terminal", createElement(ActivityRun, { messages: [message], children: null }));
    const button = host.querySelector("button")!;
    const state = ok === false ? "Failed" : "Running";
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain(state);
    expect(button.querySelector('[aria-hidden="true"]')?.textContent).not.toBe(state);
  });

  it("keeps both failure and running state on a mixed folded search", () => {
    const pending = step("Grep", "x", true, 300);
    delete pending.tool!.ok;
    const html = render("terminal", createElement(ActivityRun, {
      messages: [step("Read", "a.ts", false, 300), pending], children: null,
    }));
    expect(html).toContain("Failed");
    expect(html).toContain("Running");
  });

  it("names a search stretch the way Claude Code does", () => {
    const html = render("terminal", createElement(ActivityRun, { messages: [step("Grep", "x", true, 800), step("Read", "a.ts", true, 300)], children: null }));
    expect(html).toContain("Searched for 1 pattern, read 1 file");
    expect(html).not.toContain("2 steps");
  });
});
