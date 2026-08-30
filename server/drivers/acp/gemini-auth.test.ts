import { describe, expect, it } from "vitest";

import { geminiIsAuthenticated } from "./gemini.ts";

describe("Gemini API authentication", () => {
  it("accepts either supported API key variable", () => {
    expect(geminiIsAuthenticated({ GEMINI_API_KEY: "AIza..." })).toBe(true);
    expect(geminiIsAuthenticated({ GOOGLE_API_KEY: "AIza..." })).toBe(true);
  });

  it("rejects missing and blank keys", () => {
    expect(geminiIsAuthenticated({})).toBe(false);
    expect(geminiIsAuthenticated({ GEMINI_API_KEY: "  ", GOOGLE_API_KEY: "\t" })).toBe(false);
  });

  it("does not mistake stale OAuth or project state for API access", () => {
    expect(geminiIsAuthenticated({
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
    })).toBe(false);
  });
});
