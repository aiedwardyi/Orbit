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
  [["working"], "1 worker working", "작업자 1개 작업 중"],
  [["working", "working", "working"], "3 workers working", "작업자 3개 작업 중"],
  [["working", "working", "waiting"], "3 workers · 1 waiting", "작업자 3개 · 1개 대기 중"],
  [["working", "waiting", "failed"], "3 workers · 1 waiting · 1 failed", "작업자 3개 · 1개 대기 중 · 1개 실패"],
  [["done"], "1 worker done", "작업자 1개 완료"],
  [["done", "done", "done"], "3 workers done", "작업자 3개 완료"],
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
    expect(status?.textContent).toBe("1 worker working");
    await act(async () => status!.click());
    const list = document.body.querySelector("[data-worker-list]");
    expect(list?.getAttribute("role")).toBe("dialog");
    await act(async () => list!.querySelector<HTMLButtonElement>("li > button")!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("worker-0");
    expect(document.body.querySelector("[data-worker-list]")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps the finished count after the last pane closes", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(WorkerChip, { name: "Ada", runs: shown(["done", "done"]), livePanes: new Set<string>() })));
    expect(host.textContent).toBe("2 workers done");
    await act(async () => host.querySelector("button")!.click());
    expect(document.body.querySelectorAll("[data-worker-list] li")).toHaveLength(2);
    expect(document.body.querySelector("[data-worker-list] li > button")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
