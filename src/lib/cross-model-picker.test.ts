import { describe, expect, it } from "vitest";

import { centeredItems, freePickerModels, movePicker, pickerRows } from "./cross-model-picker";
import type { InstanceInfo } from "@/state/store";

describe("picker catalogs", () => {
  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])("wraps past the boundary with %s and skips empty rows", (key) => {
    const instances: InstanceInfo[] = ["empty-first", "first", "empty-middle", "last", "empty-last"].map((instanceId) => ({
      instanceId, driverKind: "grokAgent", displayName: instanceId, snapshot: { state: "available" },
      models: { default: "grok-4.6", options: (instanceId.startsWith("empty") ? [] : ["grok-4.6", "grok-4.5"]).map((id) => ({ id, label: id })) },
    }));
    const current = { instanceId: key === "ArrowDown" ? "last" : "first", model: key === "ArrowRight" ? "grok-4.5" : "grok-4.6", mode: "pinned" as const };
    const rows = pickerRows(instances, current);
    expect(movePicker(rows, current, key)).toEqual({
      instanceId: key === "ArrowUp" ? "last" : "first",
      model: key === "ArrowLeft" ? "grok-4.5" : "grok-4.6", mode: "pinned",
    });
  });

  it("handles empty rows without changing the selection or looping", () => {
    const instance: InstanceInfo = { instanceId: "empty", driverKind: "codex", displayName: "Empty", snapshot: { state: "available" }, models: { default: "", options: [] } };
    const current = { instanceId: "empty", model: "" };
    const rows = [{ instance, label: "Empty", cells: [] }, { instance: { ...instance, instanceId: "also-empty" }, label: "Also empty", cells: [] }];
    expect(centeredItems([], 0)).toEqual([]);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(movePicker(rows, current, key)).toEqual(current);
      expect(movePicker([], current, key)).toEqual(current);
    }
  });

  it("uses live OpenRouter rows when the catalog has no free suffix", () => {
    const options = ["other/model", "openrouter/vendor/one", "openrouter/vendor/two", "openrouter/vendor/three", "openrouter/vendor/four", "openrouter/vendor/five"].map((id) => ({ id, label: id }));
    expect(freePickerModels(options)).toEqual(options.slice(1, 5));
  });

  it("uses live free IDs and fills vacancies when the preferred families rotate out", () => {
    const options = [
      { id: "openrouter/new-vendor/new-model:free", label: "New free model" },
      { id: "openrouter/another-vendor/nemotron-3-ultra-new:free", label: "Ultra" },
      { id: "openrouter/vendor/paid-model", label: "Paid" },
      { id: "other/vendor:free", label: "Other provider" },
      { id: "openrouter/vendor/second:free", label: "Second" },
      { id: "openrouter/vendor/third:free", label: "Third" },
      { id: "openrouter/vendor/fourth:free", label: "Fourth" },
    ];
    const picked = freePickerModels(options);
    expect(picked.map((option) => option.id)).toEqual([options[1]!.id, options[0]!.id, options[4]!.id, options[5]!.id]);
    expect(freePickerModels(options.filter((option) => option !== options[1])).map((option) => option.id)).toEqual([options[0]!.id, options[4]!.id, options[5]!.id, options[6]!.id]);
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

  it("pins Muse Spark 1.3 and Contributor first on the OpenCode row, drops Ling, and keeps two free cells", () => {
    const options = [
      { id: "openrouter/vendor/ling-3.0-flash-fin:free", label: "Ling" },
      { id: "openrouter/meta/muse-spark-1.3:free", label: "Paid Muse" },
      { id: "meta/muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
      { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
      { id: "openrouter/another-vendor/nemotron-3-ultra-new:free", label: "Ultra" },
      { id: "openrouter/vendor/laguna-s-2.1:free", label: "Laguna" },
      { id: "openrouter/vendor/nemotron-3.5-lightning:free", label: "Lightning" },
    ];
    expect(freePickerModels(options).map((option) => option.id)).toEqual([
      "meta/muse-spark-1.3",
      "meta/muse-spark-1.3-contributor",
      "openrouter/another-vendor/nemotron-3-ultra-new:free",
      "openrouter/vendor/laguna-s-2.1:free",
    ]);
  });

  it("omits a missing Muse id and does not substitute another version or pin the openrouter duplicate", () => {
    const options = [
      { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
      { id: "meta/muse-spark-1.4", label: "Muse Spark 1.4" },
      { id: "openrouter/meta/muse-spark-1.3-contributor:free", label: "Paid Contributor" },
      { id: "openrouter/another-vendor/nemotron-3-ultra-new:free", label: "Ultra" },
      { id: "openrouter/vendor/second:free", label: "Second" },
      { id: "openrouter/vendor/third:free", label: "Third" },
    ];
    const ids = freePickerModels(options).map((option) => option.id);
    expect(ids).toEqual([
      "meta/muse-spark-1.3",
      "openrouter/another-vendor/nemotron-3-ultra-new:free",
      "openrouter/meta/muse-spark-1.3-contributor:free",
      "openrouter/vendor/second:free",
    ]);
    expect(ids).not.toContain("meta/muse-spark-1.4");
    expect(ids).not.toContain("meta/muse-spark-1.3-contributor");
    expect(ids[1]).not.toBe("openrouter/meta/muse-spark-1.3-contributor:free");
  });

  it("still fills remaining OpenCode slots from openrouter when the catalog has no free suffix", () => {
    const options = [
      { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
      { id: "meta/muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
      { id: "other/model", label: "other/model" },
      { id: "openrouter/vendor/one", label: "openrouter/vendor/one" },
      { id: "openrouter/vendor/two", label: "openrouter/vendor/two" },
      { id: "openrouter/vendor/three", label: "openrouter/vendor/three" },
    ];
    expect(freePickerModels(options).map((option) => option.id)).toEqual([
      "meta/muse-spark-1.3",
      "meta/muse-spark-1.3-contributor",
      "openrouter/vendor/one",
      "openrouter/vendor/two",
    ]);
  });

  it("keeps a bot on Ling as an off-list cell with that exact id after Ling leaves the keep-list", () => {
    const ling = "openrouter/vendor/ling-3.0-flash-fin:free";
    const instance: InstanceInfo = {
      instanceId: "opencode", driverKind: "opencodeGo", displayName: "OpenCode", snapshot: { state: "available" },
      models: {
        default: ling,
        options: [
          { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
          { id: "meta/muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
          { id: ling, label: "Ling" },
          { id: "openrouter/another-vendor/nemotron-3-ultra-new:free", label: "Ultra" },
          { id: "openrouter/vendor/laguna-s-2.1:free", label: "Laguna" },
        ],
      },
    };
    const rows = pickerRows([instance], { instanceId: "opencode", model: ling });
    const cells = rows[0]!.cells;
    expect(cells.map((cell) => cell.options[0]!.id)).toEqual([
      "meta/muse-spark-1.3",
      "meta/muse-spark-1.3-contributor",
      "openrouter/another-vendor/nemotron-3-ultra-new:free",
      "openrouter/vendor/laguna-s-2.1:free",
      ling,
    ]);
    expect(cells.at(-1)).toMatchObject({ offList: true, options: [{ id: ling }] });
    expect(cells.filter((cell) => cell.options.some((option) => option.id === ling))).toHaveLength(1);
  });
});
