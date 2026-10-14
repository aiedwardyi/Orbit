// execCli's --version cache. The fake CLI logs each launch to a file, so the
// counts are real process launches, not calls.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
let script: string;
let log: string;
let cli: string;

function writeCli(version: string) {
  writeFileSync(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + ";");\nconsole.log(${JSON.stringify(version)});\n`,
  );
}

function run(args: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
  return new Promise<string | null>((resolve) => {
    execCli(cli, args, { timeout: 10_000, env }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

const launches = () => readFileSync(log, "utf8").split(";").filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "procs-version-"));
  script = join(dir, "fake-cli.cjs");
  log = join(dir, "launches.log");
  writeFileSync(log, "");
  cli = `"${process.execPath}" "${script}"`;
  writeCli("fake 1.0.0");
});

afterEach(() => removeTempDir(dir));

describe("execCli --version cache", () => {
  it("launches an unchanged binary once, while auth checks still launch every time", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await run(["--version"])).toBe("fake 1.0.0");
      await run(["auth", "status"]);
    }
    expect(launches()).toEqual(["--version", "auth status", "auth status", "auth status"]);
  });

  it("launches again once the binary changes", async () => {
    expect(await run(["--version"])).toBe("fake 1.0.0");
    writeCli("fake 2.0.0-next");
    expect(await run(["--version"])).toBe("fake 2.0.0-next");
    expect(await run(["--version"])).toBe("fake 2.0.0-next");
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("keys on the env, so a probe never answers with another env's output", async () => {
    await run(["--version"], { PATH: process.env.PATH, PROBE: "a" });
    await run(["--version"], { PATH: process.env.PATH, PROBE: "b" });
    expect(launches()).toEqual(["--version", "--version"]);
  });

  it("never caches a failed probe", async () => {
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "--version;");\nprocess.exit(1);\n`);
    expect(await run(["--version"])).toBeNull();
    expect(await run(["--version"])).toBeNull();
    expect(launches()).toEqual(["--version", "--version"]);
  });
});
