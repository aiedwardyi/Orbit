import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { workerRuns, type WorkerShownState } from "@/lib/worker-runs";
import { WorkerChip, type ShownRun } from "./WorkerRows";

const shown = (states: WorkerShownState[]): ShownRun[] => states.map((state, index) => ({
  run: workerRuns([{ id: `l${index}`, role: "bot", kind: "launch", at: index, text: `Launched W${index}\nSession: worker-${index}` }])[0]!, state,
}));

afterEach(() => { applyLocale("en"); vi.unstubAllGlobals(); });

it.each([
  [[], "", ""],
  [["working"], "1 worker", "작업자 1개"],
  [["waiting"], "1 worker", "작업자 1개"],
  [["working", "working", "working"], "3 workers", "작업자 3개"],
  [["working", "working", "waiting"], "3 workers", "작업자 3개"],
  [["working", "waiting", "failed"], "3 workers", "작업자 3개"],
  [["working", "done", "failed"], "3 workers", "작업자 3개"],
  [["done"], "", ""],
  [["done", "done", "done"], "", ""],
  [["failed"], "", ""],
  [["done", "failed", "ended"], "", ""],
] as const)("says %j in English and Korean", async (states, en, ko) => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    for (const [locale, expected] of [["en", en], ["ko", ko]] as const) {
      applyLocale(locale);
      await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs: shown([...states]), livePanes: states.length ? new Set(states.map((_, index) => `worker-${index}`)) : null })));
      expect(host.textContent).toBe(expected);
      expect(host.querySelector("[data-worker-strip]")).toBeNull();
      expect(host.querySelector("svg")).toBeNull();
      expect(host.querySelector("button")?.getAttribute("aria-label") ?? "").toBe(expected);
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each([false, true])("opens the list and terminal from the words with phone=%s", async (phone) => {
  vi.stubGlobal("matchMedia", () => ({ matches: phone }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const open = vi.fn();
  try {
    await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs: shown(["working"]), livePanes: new Set(["worker-0"]), onOpenTerminalPane: open })));
    const status = host.querySelector<HTMLButtonElement>("[data-worker-status]");
    expect(status?.textContent).toBe("1 worker");
    await act(async () => status!.click());
    const list = document.body.querySelector("[data-worker-list]");
    expect(list?.getAttribute("role")).toBe("dialog");
    await act(async () => list!.querySelector<HTMLButtonElement>("li > button")!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("worker-0");
    expect(document.body.querySelector("[data-worker-list]")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("hides the status after the last pane closes", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs: shown(["done", "done"]), livePanes: new Set<string>() })));
    expect(host.textContent).toBe("");
    expect(host.querySelector("[data-worker-status]")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
