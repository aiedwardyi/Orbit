import "./ProfileFields.test-dom.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

import { ActivityRun, ActivityStep } from "./ActivityRun";

function step(name: string, summary: string | undefined, ok: boolean, durationMs: number, verb?: string): Message {
  const tool: NonNullable<Message["tool"]> = { name, ok, durationMs };
  if (summary) tool.summary = summary;
  if (verb) tool.verb = verb;
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

  it("draws a Bash step's command and output with the rest counted", () => {
    const message = step("Bash", "git status", true, 1200);
    message.tool!.detail = { input: "git status --short", output: ["M a.ts", "M b.ts", "?? c.ts"], more: 4 };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Bash</span>(git status --short)");
    expect(html).toContain("<div>M a.ts</div><div>M b.ts</div><div>?? c.ts</div><div>… +4 lines</div>");
    expect(html).not.toContain("Done (1.2s)");
    expect(html).not.toContain("ctrl+o");
    expect(html).not.toContain("<button");
    expect(html).toContain("Bash git status, done, 1.2 seconds");
  });

  it("draws an Edit as an Update with diff rows and its real counts", () => {
    const message = step("Edit", "src/a.ts +1 -1", true, 1200);
    message.tool!.detail = { input: "src/a.ts", diff: ["-const a = 1;", "+const a = 2;"] };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Update</span>(src/a.ts)");
    expect(html).toContain("<div>Updated src/a.ts with 1 addition and 1 removal</div>");
    expect(html).toContain('<div data-term-row="remove">- const a = 1;</div><div data-term-row="add">+ const a = 2;</div>');
    expect(html).toContain("Update src/a.ts +1 -1, done, 1.2 seconds");
  });

  it("invents no counts when part of a diff was cut", () => {
    const message = step("MultiEdit", "src/a.ts", true, 1200);
    message.tool!.detail = { input: "src/a.ts", diff: ["+one", "+two", "-three"], more: 2 };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).not.toContain("Updated");
    expect(html).toContain("<div>… +2 lines</div>");
  });

  it("draws a Write with its first lines", () => {
    const message = step("Write", "src/new.ts", true, 300);
    message.tool!.detail = { input: "src/new.ts", output: ["File created successfully at: src/new.ts"] };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Write</span>(src/new.ts)");
    expect(html).toContain("<div>File created successfully at: src/new.ts</div>");
  });

  it("draws an error's first line instead of Failed", () => {
    const message = step("Bash", "npm test", false, 400);
    message.tool!.detail = { input: "npm test", output: ["Exit code 1"], more: 12 };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain('data-term-step="failed"');
    expect(html).toContain("<div>Exit code 1</div><div>… +12 lines</div>");
    expect(html).not.toContain("Failed (0.4s)");
  });

  it.each([
    ["en", "Output hidden (may hold secrets)"],
    ["ko", "출력 숨김 (비밀 정보가 있을 수 있음)"],
  ] as const)("hides secret output in %s", (locale, line) => {
    const message = step("Bash", "printenv", true, 300);
    message.tool!.detail = { input: "printenv", outputHidden: true };
    document.documentElement.dataset.skin = "terminal";
    applyLocale(locale);
    const html = renderToStaticMarkup(createElement(ActivityStep, { message }));
    expect(html).toContain(`<div class="term-step-out">${line}</div>`);
  });

  it("counts cut lines and diff changes in Korean", () => {
    document.documentElement.dataset.skin = "terminal";
    applyLocale("ko");
    const bash = step("Bash", "ls", true, 300);
    bash.tool!.detail = { input: "ls", output: ["a"], more: 1 };
    expect(renderToStaticMarkup(createElement(ActivityStep, { message: bash }))).toContain("<div>… +1줄</div>");
    const edit = step("Edit", "a.ts", true, 300);
    edit.tool!.detail = { input: "a.ts", diff: ["+x", "+y"] };
    expect(renderToStaticMarkup(createElement(ActivityStep, { message: edit }))).toContain("<div>a.ts 수정: 2줄 추가</div>");
  });

  it("keeps the Done line when the detail holds no output", () => {
    const message = step("Read", "a.ts", true, 300);
    message.tool!.detail = { input: "C:/repo/a.ts" };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Read</span>(a.ts)");
    expect(html).toContain("Done (0.3s)");
    expect(html).not.toContain("term-step-out");
  });

  it("leaves other skins on the chip row with detail", () => {
    const message = step("Bash", "ls", true, 300);
    message.tool!.detail = { input: "ls -la", output: ["total 0"] };
    const html = render("tui", createElement(ActivityStep, { message }));
    expect(html).not.toContain("term-step");
    expect(html).not.toContain("total 0");
  });

  it("draws a Codex or ACP command as Bash with its output", () => {
    const message = step("git status", undefined, true, 1400, "Bash");
    message.tool!.detail = { input: "git status", output: ["M src/a.ts"] };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Bash</span>(git status)");
    expect(html).toContain("<div>M src/a.ts</div>");
    expect(html).not.toContain("Done (1.4s)");
  });

  it("draws a command with no detail as Bash and Done", () => {
    const html = render("terminal", createElement(ActivityStep, { message: step("git status", undefined, true, 800, "Bash") }));
    expect(html).toContain(">Bash</span>(git status)");
    expect(html).toContain("Done (0.8s)");
  });

  it("draws a file change as Update with the path", () => {
    const message = step("edit", undefined, true, 400, "Edit");
    message.tool!.detail = { input: "src/app.ts", diff: ["-const a = 1;", "+const a = 2;"] };
    const html = render("terminal", createElement(ActivityStep, { message }));
    expect(html).toContain(">Update</span>(src/app.ts)");
    expect(html).toContain('data-term-row="add"');
  });

  it("draws an old step with no verb from its name", () => {
    const html = render("terminal", createElement(ActivityStep, { message: step("git status", undefined, true, 800) }));
    expect(html).toContain(">git status</span></div>");
    expect(html).not.toContain(">Bash</span>");
  });

  it("leaves a verb off other skins", () => {
    const html = render("tui", createElement(ActivityStep, { message: step("git status", undefined, true, 800, "Bash") }));
    expect(html).toContain(">git status</span>");
    expect(html).not.toContain("term-step");
    expect(html).not.toContain(">Bash</span>");
  });

  it("leaves other skins on the chip row", () => {
    const html = render("tui", createElement(ActivityStep, { message: step("Edit", "src/a.ts", true, 1200) }));
    expect(html).not.toContain("term-step");
    expect(html).toContain(">Edit</span>");
  });
});

describe("ActivityRun in the Terminal skin", () => {
  it("folds an ACP read and search by their Claude Code verbs", () => {
    const html = render("terminal", createElement(ActivityRun, {
      messages: [step("src/a.ts", undefined, true, 200, "Read"), step("verb", undefined, true, 300, "Grep")],
      children: null,
    }));
    expect(html).toContain("Searched for 1 pattern, read 1 file");
  });

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
