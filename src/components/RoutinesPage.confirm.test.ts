// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import type { Bot } from "@/state/store";

const { state, dispatch } = vi.hoisted(() => ({
  state: { bots: [] as Bot[], routines: [] as Routine[], routineRuns: [], webhooks: [] },
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state, dispatch }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { RoutinesPage } from "./RoutinesPage";

it("keeps a pending routine deletion bound to the routine it was opened for", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  state.bots = [{ id: "b1", name: "Ada", color: "green" }] as Bot[];
  state.routines = ["First", "Second"].map((name, index) => ({
    id: `r${index}`, name, botId: "b1", prompt: "", enabled: true, runOn: "maus",
    schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    durationMinutes: 30, nextRunAt: Date.now(), createdAt: 1, updatedAt: 1,
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const card = (name: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.startsWith(name))!;
  const dialog = () => document.querySelector('[role="dialog"]');
  try {
    await act(async () => root.render(createElement(RoutinesPage)));
    await act(async () => card("First").click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Delete Routine"]')!.click());
    expect(dialog()?.textContent).toContain("First");
    await act(async () => card("Second").click());
    expect(dialog()?.textContent).toContain("First");
    dispatch.mockClear();
    await act(async () => [...dialog()!.querySelectorAll("button")].find((node) => node.textContent === "Delete")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "deleteRoutine", routineId: "r0" });
    expect(dialog()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
