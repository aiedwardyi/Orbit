import { describe, expect, it } from "vitest";

import { freePickerModels, pickerRows } from "./cross-model-picker";
import type { InstanceInfo } from "@/state/store";

describe("picker catalogs", () => {
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
});
