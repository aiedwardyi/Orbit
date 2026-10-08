import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const config = fileURLToPath(new URL("../../tsconfig.server.build.json", import.meta.url));

describe("server build", () => {
  it("leaves the relay test fakes out of the shipped server", () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    expect(parsed?.fileNames.some((name) => name.endsWith("server/phone-relay/index.ts"))).toBe(true);
    expect(parsed?.fileNames.filter((name) => name.includes("/phone-relay/testing/"))).toEqual([]);
  });
});
