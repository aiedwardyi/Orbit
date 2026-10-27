// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StoreProvider, type Bot } from "@/state/store";
import { canDeleteWhileWorking } from "../../shared/working-thread";
import {
  TASK_PICKER_DISMISS_MS,
  TASK_RENAME_HINT,
  TaskPicker,
  filterTasks,
  taskPickerPointerIntent,
} from "./TaskPicker";

const taskPicker = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "TaskPicker.tsx"), "utf8");

describe("taskPickerPointerIntent", () => {
  it("treats a single click as switch, not rename", () => {
    expect(taskPickerPointerIntent("click", 1)).toBe("select");
    expect(taskPickerPointerIntent("click")).toBe("select");
  });

  it("does not let the click that accompanies a double-click close the row", () => {
    // HTML fires click (detail=1), click (detail=2), then dblclick. Closing
    // on the first of those unmounts the menu before rename can start.
    expect(taskPickerPointerIntent("click", 2)).toBe("ignore");
    expect(taskPickerPointerIntent("dblclick", 2)).toBe("rename");
  });

  it("starts a rename from right-click", () => {
    expect(taskPickerPointerIntent("contextmenu")).toBe("rename");
  });

  it("ignores unrelated events", () => {
    expect(taskPickerPointerIntent("mousedown")).toBe("ignore");
  });
});

describe("task picker copy", () => {
  it("does not treat an unchecked idle thread as undeletable just because another thread is running", () => {
    expect(canDeleteWhileWorking("idle-thread", "exec-thread")).toBe(true);
    expect(canDeleteWhileWorking("exec-thread", "exec-thread")).toBe(false);
    expect(taskPicker).toContain("canDeleteWhileWorking");
    expect(taskPicker).not.toMatch(/disabled=\{busy && active\}/);
    expect(taskPicker).toContain('t("task.running")');
  });

  it("advertises both gestures the row actually handles", () => {
    expect(TASK_RENAME_HINT).toContain("double-click");
    expect(TASK_RENAME_HINT).toContain("right-click");
    expect(TASK_PICKER_DISMISS_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("filterTasks", () => {
  const tasks = [
    { title: "Clean up" },
    { title: "OpenMausBot Update" },
    { title: "Investment report" },
    { title: "Report drafts" },
  ];

  it("returns the original order when the query is empty", () => {
    expect(filterTasks(tasks, "").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
    expect(filterTasks(tasks, "   ").map((task) => task.title)).toEqual(tasks.map((task) => task.title));
  });

  it("matches titles case-insensitively", () => {
    expect(filterTasks(tasks, "openmaus").map((task) => task.title)).toEqual(["OpenMausBot Update"]);
  });

  it("ranks prefix hits ahead of substring hits, keeping input order in each tier", () => {
    expect(filterTasks(tasks, "report").map((task) => task.title)).toEqual([
      "Report drafts",
      "Investment report",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterTasks(tasks, "zzzz")).toEqual([]);
  });
});

describe("TaskPicker Back layer", () => {
  it("drops its layer when deletes leave one task", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const events: WindowEventMap["orbit:back-layer"][] = [];
    const record = (event: WindowEventMap["orbit:back-layer"]) => events.push(event);
    window.addEventListener("orbit:back-layer", record);
    const bot = (tasks: string[]): Bot => ({
      id: "b1", threadId: "t1", name: "Scout", title: "", description: "", notifications: false, color: "blue", unread: false,
      modelSelection: { instanceId: "inst", model: "m" }, messages: [], tasks: tasks.map((threadId) => ({ threadId, title: threadId, createdAt: 1 })),
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const render = (tasks: string[]) => act(async () => root.render(createElement(StoreProvider, null, createElement(TaskPicker, { bot: bot(tasks) }))));
    try {
      await render(["t1", "t2"]);
      await act(async () => host.querySelector("button")!.click());
      expect(events.map((event) => Boolean(event.detail.close))).toEqual([true]);
      await render(["t1"]);
      expect(events.map((event) => Boolean(event.detail.close))).toEqual([true, false]);
      await render(["t1", "t2"]);
      expect(events).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.removeEventListener("orbit:back-layer", record);
      vi.unstubAllGlobals();
    }
  });
});
