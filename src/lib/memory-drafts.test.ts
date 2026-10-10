// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

// each import of a fresh module copy stands in for one browser tab
const tab = async () => {
  vi.resetModules();
  return import("./memory-drafts");
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("never sends a save without a base revision", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const drafts = await tab();
  drafts.editMemory("no-read", "new note");
  await drafts.flushMemory("no-read");
  expect(fetch).not.toHaveBeenCalled();
  expect(drafts.memoryDraft("no-read")).toBe("new note");
});

it("keeps another tab's stored draft when this tab's save lands", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const a = await tab();
  const b = await tab();
  a.openMemory("two-tabs", { text: "base", revision: "r0" });
  b.openMemory("two-tabs", { text: "base", revision: "r0" });
  let finish: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (finish = resolve)));
  a.editMemory("two-tabs", "tab A text");
  const flight = a.flushMemory("two-tabs");
  b.editMemory("two-tabs", "tab B text");
  finish(new Response(JSON.stringify({ revision: "r1", truncated: false })));
  await flight;
  expect(a.memoryDraft("two-tabs")).toBeNull();
  expect((await tab()).memoryDraft("two-tabs")).toBe("tab B text");
});
