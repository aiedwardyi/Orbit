import { beforeEach, describe, expect, it } from "vitest";

import { redactSecretsInText } from "./redact.ts";

let build: typeof import("../shared/tool-detail.ts").buildToolDetail;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

beforeEach(async () => {
  build = (await import("../shared/tool-detail.ts")).buildToolDetail;
});

describe("tool detail", () => {
  it("caps input and the first three output lines", () => {
    const detail = build({ input: "echo results", output: ["a", "b", "c", "d", "e"].map((line) => line.repeat(100)).join("\n") }, redactSecretsInText);
    expect(detail.input).toBe("echo results");
    expect(detail.output).toHaveLength(3);
    expect(detail.output?.map((line) => line[0])).toEqual(["a", "b", "c"]);
    expect(detail.output?.every((line) => Array.from(line).length <= 80)).toBe(true);
    expect(detail.more).toBe(2);
    expect(bytes(detail)).toBeLessThanOrEqual(256);
  });

  it("measures UTF-8 without splitting Unicode characters", () => {
    const detail = build({ input: "한🧠".repeat(100), output: "é🧠한".repeat(100) }, redactSecretsInText);
    expect(bytes(detail)).toBeLessThanOrEqual(256);
    expect(Array.from(detail.input ?? "").length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(detail)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    expect(detail.output?.[0]).toBeTruthy();
  });

  it("clips a very long single line", () => {
    const detail = build({ output: "x".repeat(20_000) }, redactSecretsInText);
    expect(detail).toEqual({ output: ["x".repeat(80)] });
  });

  it("normalizes CRLF and ignores a trailing line terminator", () => {
    expect(build({ output: "one\r\ntwo\r\nthree\r\nfour\r\n" }, redactSecretsInText)).toEqual({ output: ["one", "two", "three"], more: 1 });
  });

  it("omits empty output", () => {
    expect(build({ input: "echo done", output: "" }, redactSecretsInText)).toEqual({ input: "echo done" });
    expect(build({}, redactSecretsInText)).toEqual({});
  });

  it("keeps diff lines instead of output", () => {
    expect(build({ input: "app.ts", diff: ["-before", "+after"], output: "updated" }, redactSecretsInText)).toEqual({ input: "app.ts", diff: ["-before", "+after"] });
  });

  it("redacts whole input and output before cutting", () => {
    const key = `sk-proj-${"abcdef0123456789".repeat(12)}`;
    const detail = build({ input: `${"x".repeat(109)} ${key}`, output: `${"y".repeat(75)} ${key}\n${key}` }, redactSecretsInText);
    expect(JSON.stringify(detail)).not.toContain("sk-proj-");
    expect(JSON.stringify(detail)).not.toContain("abcdef0123456789");
    expect(bytes(detail)).toBeLessThanOrEqual(256);
  });

  it("hides output and diff while keeping a redacted header", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(build({ input: `echo token=${key}`, output: "opaque-sensitive-value", diff: ["+opaque-sensitive-value"], outputHidden: true }, redactSecretsInText)).toEqual({ input: "echo token=«redacted 40 chars»", outputHidden: true });
  });

  it("keeps an error's first line and counts the rest", () => {
    expect(build({ output: "failed\r\nreason\r\nstack\r\n", isError: true }, redactSecretsInText)).toEqual({ output: ["failed"], more: 2 });
  });

  it("enforces 256 bytes on a seeded corpus", () => {
    let seed = 0x68126c25;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const alphabet = ["a", "Z", "한", "é", "🧠", '"', "\\", "\t", "\u0000", "\u2028"];
    const text = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");
    const sizes: number[] = [];
    for (let i = 0; i < 2500; i++) {
      const lines = Array.from({ length: random(16) }, () => text(random(160)));
      const input = text(random(180));
      const detail = build(i % 3 === 0 ? { input, diff: lines } : { input, output: lines.join(i % 2 ? "\n" : "\r\n") }, redactSecretsInText);
      sizes.push(bytes(detail));
      expect(sizes.at(-1), `case ${i}`).toBeLessThanOrEqual(256);
      expect(Array.from(detail.input ?? "").length).toBeLessThanOrEqual(120);
      expect((detail.output ?? detail.diff ?? []).length).toBeLessThanOrEqual(3);
      expect((detail.output ?? detail.diff ?? []).every((line) => Array.from(line).length <= 80)).toBe(true);
      expect(detail.output === undefined || detail.diff === undefined).toBe(true);
    }
    sizes.sort((a, b) => a - b);
    console.info(JSON.stringify({ corpus: sizes.length, max: sizes.at(-1), median: (sizes[1249] + sizes[1250]) / 2 }));
  });
});
