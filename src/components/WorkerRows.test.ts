import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { workerRuns, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";
import { applyLocale } from "@/lib/i18n";
import { WORKER_STATUS, WorkerRow } from "./WorkerRows";

const run = (label: string) => {
  const launch: Message = { id: "l1", at: 1, role: "bot", kind: "launch", text: `Launched ${label}\nLabel: ${label}\nWorking folder: C:\\repo\nSession: aaaaaaaa-1` };
  return workerRuns([launch])[0]!;
};

describe("WorkerRow", () => {
  it.each([
    ["working", "●", "Working", "text-accent"],
    ["waiting", "?", "Waiting", "text-warning"],
    ["failed", "!", "Failed", "text-danger"],
    ["done", "✓", "Done", "text-success"],
    ["ended", "○", "Ended", "text-ink-secondary"],
  ] as const)("shows %s as a glyph and a word in its theme color", (state: WorkerShownState, glyph, word, tone) => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state, live: null }));
    expect(markup).toContain(`data-worker-state="${state}"`);
    expect(markup).toContain(tone);
    expect(markup).toContain(`<span aria-hidden="true">${glyph}</span>${word}`);
    expect(WORKER_STATUS[state].text).toBe(tone);
  });

  it.each([
    ["Opus 5.5", "claudeAgent"], ["GPT-6 Astra", "codex"], ["Gemini 3.8", "geminiAgent"], ["Grok 4.7", "grokAgent"], ["Muse 1.3", "museAgent"],
  ])("draws the %s mark exactly as the model picker does", (model, driverKind) => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run(`A | ${model} | high`), state: "waiting", live: null }));
    expect(markup).toContain(renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 })));
  });

  it("spans the whole transcript column like a message", () => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state: "working", live: null }));
    expect(markup).toMatch(/^<div data-worker-run="[^"]*" class="flex w-full flex-col">/);
  });

  it("gives a script a neutral terminal glyph, not a brand", () => {
    const markup = renderToStaticMarkup(createElement(WorkerRow, { run: run("POST-166 | script"), state: "working", live: null }));
    expect(markup).toContain("lucide-square-terminal");
    expect(markup).not.toContain("#D97757");
  });

  it.each([
    ["done", true, "Ran in C:\\repo"],
    ["failed", true, "Ran in C:\\repo"],
    ["ended", false, "Ran in C:\\repo"],
    ["working", true, "Running in C:\\repo"],
    ["waiting", false, "Folder: C:\\repo"],
    ["working", null, "Folder: C:\\repo"],
  ] as const)("opens a %s run with live=%s on '%s'", async (state: WorkerShownState, live, line) => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(WorkerRow, { run: run("A | Opus 5.5 | high"), state, live })));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("[data-orbit-worker]")!.textContent).toContain(line);
    await act(async () => root.unmount());
    host.remove();
  });
});
