import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, saveConfig } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";
import { captureToolDetail } from "./tool-detail.ts";

let build: typeof import("../shared/tool-detail.ts").buildToolDetail;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

beforeEach(async () => {
  build = (await import("../shared/tool-detail.ts")).buildToolDetail;
});

describe("tool detail safety", () => {
  const secret = "PreviewCanary987654321";

  beforeEach(() => {
    ensureDirs();
    saveConfig({ features: { toolDetailCapture: true } });
  });

  afterEach(() => saveConfig({ features: { toolDetailCapture: false } }));

  it.each([
    ["URL userinfo", `postgres://admin:${secret}@db.example/test`],
    ["Cookie", `Cookie: session=${secret}; theme=dark`],
    ["Set-Cookie", `Set-Cookie: session=${secret}; HttpOnly; Secure`],
    ["double quotes", `PASSWORD="${secret} with spaces"`],
    ["single quotes", `DB_PASSWORD='${secret} with spaces'`],
    ["escaped quotes", String.raw`TOKEN="${secret} with \"quotes\""`],
    ["quoted name", `{"SESSION": "${secret} with spaces"}`],
    ["controls", `PASSWORD=\u0007${secret}\u202e`],
    ["carriage return", `KEY=\r${secret}`],
    ["embedded control", `PASS\u0000WORD=${secret}`],
  ])("masks %s before clipping", (_label, output) => {
    const detail = captureToolDetail({ name: "Bash", command: "npm run diagnose", output: `${"x".repeat(35)} ${output}` });
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).toContain("redacted");
    expect(bytes(detail)).toBeLessThanOrEqual(256);
  });

  it.each(["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PASS", "CREDENTIAL", "CREDENTIALS", "AUTH", "SESSION", "SSH_KEY", "DB_PASSWORD", "db-password"])("masks the complete %s assignment", (name) => {
    const detail = captureToolDetail({ name: "Bash", output: `${name}=${secret}` });
    expect(detail?.output).toEqual([`${name}=«redacted ${secret.length} chars»`]);
  });

  it.each([
    `sk-proj-${secret}`, `ghp_${secret}`, `github_pat_${secret}`, `xoxb-${secret}`,
    "AKIAABCDEFGHIJKLMNOP", `AIza${secret.repeat(2)}`, `ya29.${secret}`, `npm_${secret}`,
    `xai-${secret}`, `sk_live_${secret.repeat(2)}`, `ak_${secret}`,
    `eyJ${"A".repeat(20)}.${"B".repeat(20)}.${"C".repeat(20)}`,
    `${"a".repeat(8)}.${"Q".repeat(43)}`,
  ])("masks a key after ANSI: %s", (key) => {
    const detail = captureToolDetail({ name: "Bash", output: `\u001b[32m${key}\u001b[0m` });
    expect(detail?.output).toEqual([`«redacted ${key.length} chars»`]);
  });

  it.each([`PASSWORD="${secret} with spaces`, `PASS='${secret} with spaces`, `AUTH=${secret} unbounded tail`, "KEY=", "Authorization:"])("hides an unbounded credential line: %s", (output) => {
    const detail = captureToolDetail({ name: "Bash", output: `diagnostic ${output}` });
    expect(detail?.output?.[0]).toMatch(/^«redacted \d+ chars»$/);
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  it("keeps URL scheme, host and PWD while stripping control sequences", () => {
    const detail = captureToolDetail({ name: "Bash", output: `\u001b]0;title\u0007postgres://admin:${secret}@db.example/test\u001b[0m\u202e\nPWD=/work/app` });
    expect(detail?.output?.[0]).toContain("postgres://");
    expect(detail?.output?.[0]).toContain("@db.example/test");
    expect(detail?.output?.[1]).toBe("PWD=/work/app");
    for (const control of ["\u001b", "\u0007", "\u202e"]) expect(detail?.output?.join("\n")).not.toContain(control);
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  it.each(["output", "diff"])("masks a context-free PEM body in %s and keeps pure hex", (field) => {
    const body = `${secret}+/${secret}==`;
    const hex = "aBcD0123456789".repeat(4);
    const detail = captureToolDetail(field === "diff"
      ? { name: "Edit", input: "notes.txt", edits: [{ oldText: hex, newText: body }] }
      : { name: "Bash", output: `${body}\n${hex}` });
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).toContain(hex);
  });

  it.each([
    "cert.pem", "private.key", "cert.p12", "cert.pfx", "store.jks", "store.keystore", "putty.ppk", "vault.kdbx",
    "id_rsa.pub", "id_dsa", "id_ecdsa_backup", "id_ed25519", ".env", ".env.production", ".netrc", ".pgpass", ".npmrc", ".pypirc",
    "credentials.json", "app-secret.txt", "/work/.ssh/config", "C:\\work\\.gnupg\\config", "C:\\work\\CERT.PEM",
  ])("hides sensitive target %s without copying its input body", (path) => {
    const detail = captureToolDetail({ name: "Write", rawInput: { path, content: secret }, output: secret });
    expect(detail).toEqual({ input: path, outputHidden: true });
  });

  it("hides partial PEM edits and patches from legacy path headers", () => {
    for (const change of [{ edits: [{ oldText: "OldBody987654321", newText: secret }] }, { patches: [`@@ -20 +20 @@\n-OldBody987654321\n+${secret}\n`] }]) {
      expect(captureToolDetail({ name: "Edit", input: "cert.pem", ...change })).toEqual({ input: "cert.pem", outputHidden: true });
    }
  });

  it("masks complete quoted values before clipping and keeps following fields", () => {
    const value = `${secret.repeat(40)} with spaces`;
    const detail = captureToolDetail({ name: "Bash", output: `PASSWORD="${value}" STATUS=ok` });
    expect(detail?.output).toEqual([`PASSWORD="«redacted ${value.length} chars»" STATUS=ok`]);
    expect(bytes(detail)).toBeLessThanOrEqual(256);
  });
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
