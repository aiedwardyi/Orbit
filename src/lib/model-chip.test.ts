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
      "Orbit is choosing a working engine for this job. Currently Grok 4.6.",
    );
  });

  it("says unresolved when automatic has no live instance yet", () => {
    expect(modelChipTitle({ mode: "automatic", model: "grok-4.6" }, t)).toBe(
      "Orbit is choosing a working engine for this job. Currently unresolved.",
    );
  });

  it("uses a complete pinned phrase instead of glued fragments", () => {
    expect(modelChipTitle({ mode: "pinned", instance: grok, model: "grok-4.5" }, t)).toBe(
      "Grok · Grok 4.5",
    );
  });
});

describe("engineBadgeText", () => {
  it("labels a CLI package version so it is not read as the chat model", () => {
    expect(engineBadgeText({ version: "1.0.13" }, "ready", t)).toBe("CLI 1.0.13");
    expect(engineBadgeText({ version: "1.0.13" }, "ready", t)).not.toBe("1.0.13");
  });

  it("keeps install and sign-in states as complete phrases", () => {
    expect(engineBadgeText({}, "not-installed", t)).toBe("Not installed");
    expect(engineBadgeText({ version: "1.0.13" }, "sign-in", t)).toBe("Sign-in required");
    expect(engineBadgeText({}, "ready", t)).toBe("Ready");
    expect(engineBadgeText({ version: null }, "ready", t)).toBe("Ready");
  });
});
