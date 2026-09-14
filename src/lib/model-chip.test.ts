import { describe, expect, it } from "vitest";

import { translate } from "./i18n";
import {
  displayedChipEffort,
  engineBadgeText,
  modelChipText,
  modelChipTitle,
  modelFamilyAccent,
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

  it("strips a tier in parens from an Antigravity catalog label", () => {
    const antigravity = {
      displayName: "Gemini (Antigravity)",
      models: {
        default: "gemini-3.8-flash-high",
        options: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ],
      },
    };
    expect(
      modelChipText({ instance: antigravity, model: "gemini-3.8-flash-high" }, t),
    ).toBe("Gemini 3.8 Flash");
    expect(
      modelChipText({ instance: antigravity, model: "gemini-3.8-flash-high" }, t),
    ).not.toMatch(/\(High\)/);
  });

  it("keeps a lone legacy tier label verbatim when no badge renders", () => {
    const legacy = {
      displayName: "Legacy",
      models: {
        default: "gpt-oss-120b-medium",
        options: [{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }],
      },
    };
    expect(displayedChipEffort(legacy, "gpt-oss-120b-medium", undefined)).toBeUndefined();
    expect(modelChipText({ instance: legacy, model: "gpt-oss-120b-medium" }, t)).toBe(
      "GPT-OSS 120B (Medium)",
    );
    expect(
      modelChipTitle({ mode: "pinned", instance: legacy, model: "gpt-oss-120b-medium" }, t),
    ).toContain("(Medium)");
  });

  it("keeps non-tier parens such as Auto (recommended) verbatim", () => {
    const gemini = {
      displayName: "Gemini API",
      models: {
        default: "auto",
        options: [{ id: "auto", label: "Auto (recommended)" }],
      },
    };
    expect(modelChipText({ instance: gemini, model: "auto" }, t)).toBe(
      "Auto (recommended)",
    );
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

  it("keeps the tooltip truthful with the derived tier for suffixed ids", () => {
    const title = modelChipTitle(
      { mode: "pinned", instance: antigravity, model: "gemini-3.8-flash-high" },
      t,
    );
    expect(title).toContain("Gemini 3.8 Flash");
    expect(title).toContain("high");
    expect(title).not.toMatch(/\(High\)/);
  });

  it("localizes the tooltip effort while the badge does the same", () => {
    const tko = (
      key: Parameters<typeof translate>[1],
      vars?: Record<string, string | number>,
    ) => translate("ko", key, vars);
    const title = modelChipTitle(
      { mode: "pinned", instance: antigravity, model: "gemini-3.8-flash-high" },
      tko,
    );
    expect(title).toContain("높음");
    expect(title).not.toMatch(/\(High\)/);
  });
});

const antigravity = {
  displayName: "Gemini (Antigravity)",
  models: {
    default: "gemini-3.8-flash-high",
    options: [
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    ],
  },
};

describe("displayedChipEffort", () => {
  it("derives effort from a tier-suffixed model id when effort is unset", () => {
    expect(displayedChipEffort(antigravity, "gemini-3.8-flash-high", undefined)).toBe(
      "high",
    );
    expect(displayedChipEffort(antigravity, "gemini-3.8-flash-low", undefined)).toBe(
      "low",
    );
  });

  it("shows name-only effort when the stem has no catalog family", () => {
    expect(displayedChipEffort(antigravity, "retired-model-high", undefined)).toBeUndefined();
  });

  it("prefers an explicit selection.effort over the id suffix", () => {
    expect(displayedChipEffort(antigravity, "gemini-3.8-flash-low", "high")).toBe("high");
  });

  it("leaves suffix-free selections alone", () => {
    expect(displayedChipEffort(grok, "grok-4.6", undefined)).toBeUndefined();
  });

  it("shows no badge for a lone suffixed option with no tier siblings", () => {
    const cursor = {
      displayName: "Cursor",
      models: {
        default: "claude-sonnet-5-thinking-high",
        options: [{ id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking" }],
      },
    };
    expect(displayedChipEffort(cursor, "claude-sonnet-5-thinking-high", undefined)).toBeUndefined();
  });

  it("counts a bare stem sibling as family evidence", () => {
    const bare = {
      displayName: "Test",
      models: {
        default: "model-x-high",
        options: [
          { id: "model-x", label: "Model X" },
          { id: "model-x-high", label: "Model X (High)" },
        ],
      },
    };
    expect(displayedChipEffort(bare, "model-x-high", undefined)).toBe("high");
  });
});

describe("modelFamilyAccent", () => {
  it.each([
    ["codex", "#3594ff"],
    ["claudeAgent", "#ed6549"],
    ["museAgent", "#43ce8b"],
    ["geminiAgent", "#aa7bfa"],
    ["antigravityAgent", "#aa7bfa"],
    ["grokAgent", "#8b929c"],
  ])("paints the %s chip with %s", (driverKind, accent) => {
    expect(modelFamilyAccent(driverKind)).toBe(accent);
  });

  it("falls back to the grok grey when the driver is unknown", () => {
    expect(modelFamilyAccent("mysteryDriver")).toBe("#8b929c");
    expect(modelFamilyAccent(undefined)).toBe("#8b929c");
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
