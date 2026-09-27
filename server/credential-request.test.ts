import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_TARGETS,
  credentialConfigPatch,
  credentialIsConfigured,
  credentialResumeOutcome,
  isCustomCredentialId,
  isReusableCredentialRequest,
  isCredentialTargetId,
  parseCustomService,
  type CredentialConfig,
  type CredentialTargetId,
} from "../shared/credential-request.ts";

const MAPPINGS: Array<[CredentialTargetId, CredentialConfig]> = [
  ["xaiApiKey", { xai: { key: "secret" } }],
  ["geminiApiKey", { gemini: { apiKey: "secret" } }],
  ["boxToken", { box: { token: "secret" } }],
  ["ttsKey", { tts: { key: "secret" } }],
  ["openaiImageApiKey", { imageGen: { key: "secret" } }],
  ["anthropicApiKey", { anthropic: { key: "secret" } }],
  ["vertexApiKey", { vertex: { key: "secret" } }],
];

describe("credential request allowlist", () => {
  it("accepts only declared own ids", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("composioApiKey")).toBe(false);
    expect(isCredentialTargetId("__proto__")).toBe(false);
    expect(isCredentialTargetId({ toString: () => "xaiApiKey" })).toBe(false);
  });

  it("maps each id to a fixed config location", () => {
    expect(MAPPINGS.map(([id]) => id).sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [id, patch] of MAPPINGS) {
      expect(credentialConfigPatch(id, "secret")).toEqual(patch);
      expect(credentialIsConfigured(patch, id)).toBe(true);
      expect(credentialIsConfigured({}, id)).toBe(false);
    }
  });

  it("checks configured state without exposing values", () => {
    expect(credentialIsConfigured({ tts: { key: "secret" } }, "ttsKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { key: "" } }, "ttsKey")).toBe(false);
    expect(Object.keys(CREDENTIAL_TARGETS)).toHaveLength(7);
  });

  it("reuses open room cards only for the bot that requested them", () => {
    const card = {
      kind: "secret",
      secret: { target: "xaiApiKey" },
      from: { botId: "atlas" },
    };
    expect(isReusableCredentialRequest(card, "xaiApiKey", "atlas", true)).toBe(true);
    expect(isReusableCredentialRequest(card, "xaiApiKey", "pixel", true)).toBe(false);
    expect(isReusableCredentialRequest(card, "xaiApiKey", "pixel", false)).toBe(true);
    expect(isReusableCredentialRequest({ ...card, secret: { ...card.secret, provided: true } }, "xaiApiKey", "atlas", true)).toBe(false);
  });

  it("parses a custom service with bearer defaults", () => {
    expect(parseCustomService({ name: " Acme ", host: "api.acme.dev" })).toEqual({
      service: { name: "Acme", host: "api.acme.dev", header: "authorization", prefix: "Bearer " },
    });
    expect(parseCustomService({ name: "Acme", host: "api.acme.dev", header: "X-Api-Key" })).toEqual({
      service: { name: "Acme", host: "api.acme.dev", header: "x-api-key", prefix: "" },
    });
    expect(credentialIsConfigured({ customKeys: { "api.acme.dev": { name: "Acme", header: "x", prefix: "", key: "k" } } }, "custom:api.acme.dev")).toBe(true);
    expect(credentialIsConfigured({ customKeys: { "api.acme.dev": null } }, "custom:api.acme.dev")).toBe(false);
  });

  it.each([
    "https://api.acme.dev", "api.acme.dev:443", "api.acme.dev/v1", "*.acme.dev", "API.acme.dev", "10.0.0.1",
    "localhost", "printer.local", "db.internal", "acme", "[::1]", "a..b.dev",
  ])("rejects custom host %s", (host) => {
    expect(parseCustomService({ name: "Acme", host })).toHaveProperty("error");
    expect(isCustomCredentialId(`custom:${host}`)).toBe(false);
  });

  it.each(["host", "cookie", "content-length", "transfer-encoding", "proxy-authorization", "x key", "x-key\r\nx", "", 5])(
    "rejects custom header %s",
    (header) => {
      expect(parseCustomService({ name: "Acme", host: "api.acme.dev", header })).toHaveProperty("error");
    },
  );

  it("preserves the original save or decline outcome when retrying", () => {
    expect(credentialResumeOutcome({ provided: true })).toBe("provided");
    expect(credentialResumeOutcome({ dismissed: true })).toBe("dismissed");
    expect(credentialResumeOutcome({})).toBeNull();
    expect(credentialResumeOutcome({ provided: true, dismissed: true })).toBeNull();
  });
});
