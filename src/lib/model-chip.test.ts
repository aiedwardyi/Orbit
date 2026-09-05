import { describe, expect, it } from "vitest";

import { translate } from "./i18n";
import {
  engineBadgeText,
  modelChipText,
  modelChipTitle,
} from "./model-chip";

const grok = {
  displayName: "Grok",
  driverKind: "grokAgent",
  models: {
    default: "grok-4.6",
    options: [
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
  },
};

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("en", key, vars);

describe("modelChipText", () => {
  it("shows the live model name in automatic mode, never the word Automatic", () => {
    expect(modelChipText({ instance: grok, model: "grok-4.6" }, t)).toBe("Grok 4.6");
    expect(modelChipText({ instance: grok, model: "grok-4.6" }, t)).not.toMatch(/automatic/i);
  });

  it("keeps the pinned model label", () => {
    expect(modelChipText({ instance: grok, model: "grok-4.5" }, t)).toBe("Grok 4.5");
  });

  it("falls back to the raw id when the catalog row is missing", () => {
    expect(modelChipText({ model: "grok-4.6" }, t)).toBe("grok-4.6");
  });

  it("uses unresolved when there is no live model id", () => {
    expect(modelChipText({ model: "" }, t)).toBe("unresolved");
  });
});

describe("modelChipTitle", () => {
  it("names the live engine in the automatic tooltip", () => {
    expect(modelChipTitle({ mode: "automatic", instance: grok, model: "grok-4.6" }, t)).toBe(
      "Stay on this engine while it works. Currently Grok 4.6.",
    );
  });

  it("says unresolved when automatic has no live instance yet", () => {
    expect(modelChipTitle({ mode: "automatic", model: "grok-4.6" }, t)).toBe(
      "Stay on this engine while it works. Currently unresolved.",
    );
  });

  it("uses a complete pinned phrase instead of glued fragments", () => {
    expect(modelChipTitle({ mode: "pinned", instance: grok, model: "grok-4.5" }, t)).toBe(
      "Grok · Grok 4.5",
    );
  });
});

describe("engineBadgeText", () => {
  it("shows a Ready label, never the raw CLI --version dump", () => {
    expect(engineBadgeText({ version: "1.0.13" }, "ready", t)).toBe("Ready");
    expect(
      engineBadgeText({ version: "grok 1.0.13 (5e9a58528b76) [stable]" }, "ready", t),
    ).toBe("Ready");
    expect(engineBadgeText({ version: "2.1.259 (Claude Code)" }, "ready", t)).toBe("Ready");
    expect(engineBadgeText({ version: "2.1.259 (Claude Code)" }, "ready", t)).not.toMatch(
      /CLI|2\.1\.259|Claude Code/,
    );
  });

  it("keeps install and sign-in states as complete phrases", () => {
    expect(engineBadgeText({}, "not-installed", t)).toBe("Not installed");
    expect(engineBadgeText({ version: "1.0.13" }, "sign-in", t)).toBe("Sign-in required");
    expect(engineBadgeText({}, "ready", t)).toBe("Ready");
    expect(engineBadgeText({ version: null }, "ready", t)).toBe("Ready");
  });
});
