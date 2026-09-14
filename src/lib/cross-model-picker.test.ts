import { describe, expect, it } from "vitest";

import { pickerModels, movePicker, pickerRows, pickerEfforts, withPickerEffort } from "./cross-model-picker";
import type { InstanceInfo } from "@/state/store";

describe("picker catalogs", () => {
  it("offers only the declared effort levels", () => {
    const instance: InstanceInfo = {
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", snapshot: { state: "available" },
      models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    };
    const row = pickerRows([instance], { instanceId: "grok", model: "grok-4.6" })[0]!;
    expect(pickerEfforts(row, row.cells[0]!).map((option) => option.id)).toEqual(["low", "medium", "high"]);
  });

  it.each(["claude-haiku-4-5", "retired/exact-model:pin"])("never defaults an off-list pin %s", (model) => {
    const instance: InstanceInfo = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" },
      models: { default: "claude-sonnet-5", options: [{ id: model, label: model }] },
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    };
    const selection = { instanceId: "claude", model, mode: "pinned" as const };
    expect(withPickerEffort(instance, selection)).toBe(selection);
  });

  it.each(["antigravityAgent", "museAgent"])("never adds an effort field for %s", (driverKind) => {
    const model = driverKind === "antigravityAgent" ? "gemini-3.8-flash-low" : "muse-spark-1.3";
    const instance: InstanceInfo = {
      instanceId: "engine", driverKind, displayName: "Engine", snapshot: { state: "available" },
      models: { default: model, options: [{ id: model, label: model }] },
    };
    const selection = { instanceId: "engine", model };
    expect(withPickerEffort(instance, selection)).toBe(selection);
  });

  it("orders the model column frontier-first without changing the catalog default", () => {
    const instance: InstanceInfo = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" },
      models: { default: "claude-sonnet-5", options: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-fable-5-1"].map((id) => ({ id, label: id })) },
    };
    const before = JSON.stringify(instance.models);
    const rows = pickerRows([instance], { instanceId: "claude", model: "claude-opus-5", mode: "pinned" });
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.id)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(JSON.stringify(instance.models)).toBe(before);
  });

  it.each(["ArrowUp", "ArrowDown"])("wraps past the boundary with %s and skips empty rows", (key) => {
    const instances: InstanceInfo[] = ["empty-first", "first", "empty-middle", "last", "empty-last"].map((instanceId) => ({
      instanceId, driverKind: "grokAgent", displayName: instanceId, snapshot: { state: "available" },
      models: { default: "grok-4.6", options: (instanceId.startsWith("empty") ? [] : ["grok-4.6", "grok-4.5"]).map((id) => ({ id, label: id })) },
    }));
    const current = { instanceId: key === "ArrowDown" ? "last" : "first", model: key === "ArrowDown" ? "grok-4.5" : "grok-4.6", mode: "pinned" as const };
    const rows = pickerRows(instances, current);
    expect(movePicker(rows, current, key)).toEqual({
      instanceId: key === "ArrowUp" ? "last" : "first",
      model: key === "ArrowUp" ? "grok-4.5" : "grok-4.6", mode: "pinned",
    });
  });

  it("handles empty rows without changing the selection or looping", () => {
    const instance: InstanceInfo = { instanceId: "empty", driverKind: "codex", displayName: "Empty", snapshot: { state: "available" }, models: { default: "", options: [] } };
    const current = { instanceId: "empty", model: "" };
    const rows = [{ instance, label: "Empty", cells: [] }, { instance: { ...instance, instanceId: "also-empty" }, label: "Also empty", cells: [] }];
    expect(pickerModels(rows)).toEqual([]);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(movePicker(rows, current, key)).toEqual(current);
      expect(movePicker([], current, key)).toEqual(current);
    }
  });

  it("leaves the full driver catalog intact while keeping only the requested models", () => {
    const instance: InstanceInfo = {
      instanceId: "codex", driverKind: "codex", displayName: "OpenAI", snapshot: { state: "available" },
      models: { default: "other-model", options: ["other-model", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((id) => ({ id, label: id })) },
    };
    const before = JSON.stringify(instance.models);
    const rows = pickerRows([instance], { instanceId: "codex", model: "gpt-6-astra" });
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(JSON.stringify(instance.models)).toBe(before);
  });

  it("serves exactly the two Meta Muse models with the required labels", () => {
    const instance: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: {
        default: "muse-spark-1.3",
        options: [
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
          { id: "other-model", label: "Other" },
        ],
      },
    };
    const rows = pickerRows([instance], { instanceId: "muse", model: "muse-spark-1.3" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Meta Muse");
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
    ]);
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.label)).toEqual([
      "Meta Muse 1.3",
      "Meta Muse 1.3 Contributor",
    ]);
  });

  it("omits a missing Meta Muse id without substitution", () => {
    const instance: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: {
        default: "muse-spark-1.3",
        options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }],
      },
    };
    const rows = pickerRows([instance], { instanceId: "muse", model: "muse-spark-1.3" });
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.id)).toEqual(["muse-spark-1.3"]);
  });

  it("keeps a retired Meta Muse pick as an off-list cell", () => {
    const retired = "muse-spark-1.2";
    const instance: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: {
        default: retired,
        options: [
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
          { id: retired, label: retired },
        ],
      },
    };
    const rows = pickerRows([instance], { instanceId: "muse", model: retired });
    const cells = rows[0]!.cells;
    expect(cells.map((cell) => cell.options[0]!.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      retired,
    ]);
    expect(cells.at(-1)).toMatchObject({ offList: true, options: [{ id: retired }] });
  });

  it("collapses duplicate roster options to one cell per model", () => {
    const instance: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: {
        default: "muse-spark-1.3",
        options: [
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
        ],
      },
    };
    const rows = pickerRows([instance], { instanceId: "muse", model: "muse-spark-1.3" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells.map((cell) => cell.options[0]!.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
    ]);
  });

  it("preserves effort when jumping across engines that support it", () => {
    const grok: InstanceInfo = {
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", snapshot: { state: "available" },
      models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    };
    const muse: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: { default: "muse-spark-1.3", options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }] },
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh"] },
    };
    const current = { instanceId: "grok", model: "grok-4.6", mode: "pinned" as const, effort: "high" as const };
    const rows = pickerRows([grok, muse], current);
    expect(movePicker(rows, current, "ArrowDown")).toEqual({
      instanceId: "muse", model: "muse-spark-1.3", mode: "pinned" as const, effort: "high" as const,
    });
  });

  it("carries an Antigravity id-encoded tier across the jump as effort", () => {
    const grok: InstanceInfo = {
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", snapshot: { state: "available" },
      models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    };
    const antigravity: InstanceInfo = {
      instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Gemini (Antigravity)", snapshot: { state: "available" },
      models: {
        default: "gemini-3.8-flash-high",
        options: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ],
      },
      capabilities: {},
    };
    const current = { instanceId: "antigravity", model: "gemini-3.8-flash-high", mode: "pinned" as const };
    const rows = pickerRows([grok, antigravity], current);
    expect(movePicker(rows, current, "ArrowDown")).toEqual({
      instanceId: "grok", model: "grok-4.6", mode: "pinned", effort: "high" as const,
    });
  });

  it("drops an Antigravity id-encoded tier when the target has no effort levels", () => {
    const muse: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: { default: "muse-spark-1.3", options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }] },
      capabilities: {},
    };
    const antigravity: InstanceInfo = {
      instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Gemini (Antigravity)", snapshot: { state: "available" },
      models: {
        default: "gemini-3.8-flash-high",
        options: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ],
      },
      capabilities: {},
    };
    const current = { instanceId: "antigravity", model: "gemini-3.8-flash-high", mode: "pinned" as const };
    const rows = pickerRows([muse, antigravity], current);
    expect(movePicker(rows, current, "ArrowDown")).toEqual({
      instanceId: "muse", model: "muse-spark-1.3", mode: "pinned" as const,
    });
  });

  it("clears effort when jumping to an engine that does not support it", () => {
    const grok: InstanceInfo = {
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", snapshot: { state: "available" },
      models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    };
    const muse: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: { default: "muse-spark-1.3", options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }] },
      capabilities: {},
    };
    const current = { instanceId: "grok", model: "grok-4.6", mode: "pinned" as const, effort: "high" as const };
    const rows = pickerRows([grok, muse], current);
    expect(movePicker(rows, current, "ArrowDown")).toEqual({
      instanceId: "muse", model: "muse-spark-1.3", mode: "pinned",
    });
  });

  it("offers Max above Extra High for Meta Muse and Contributor", () => {
    const instance: InstanceInfo = {
      instanceId: "muse", driverKind: "museAgent", displayName: "Meta Muse", snapshot: { state: "available" },
      models: {
        default: "muse-spark-1.3",
        options: [
          { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
          { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
        ],
      },
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    };
    const rows = pickerRows([instance], { instanceId: "muse", model: "muse-spark-1.3" });
    const row = rows[0]!;
    for (const cell of row.cells) {
      expect(pickerEfforts(row, cell).map((option) => option.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
    for (const model of ["muse-spark-1.3", "muse-spark-1.3-contributor"] as const) {
      const current = { instanceId: "muse", model, mode: "pinned" as const, effort: "xhigh" as const };
      expect(movePicker(rows, current, "ArrowRight")).toEqual({ ...current, effort: "max" });
    }
  });
});
