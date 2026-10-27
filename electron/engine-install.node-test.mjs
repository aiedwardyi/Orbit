import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as terminal from "./terminal-launch.mjs";

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  for (const scenario of ["success", "failure", "npm present", "npm missing", "winget failure", "winget missing", "irm success", "irm failure", "installer exit"]) {
    test(`${shell}: ${scenario}`, { skip: process.platform !== "win32" }, () => {
      const dir = mkdtempSync(join(tmpdir(), "wink-engine-install-"));
      const bin = join(dir, "fresh-bin");
      mkdirSync(bin);
      const log = join(dir, "calls.txt");
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const cmd = (name, body) => writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${body}\r\n`);
      try {
        cmd("install", `echo install>>"${log}"\r\nexit /b ${scenario === "failure" ? 7 : 0}`);
        cmd("fresh-bin/signin", `echo signin>>"${log}"\r\nexit /b 0`);
        cmd("staged-npm", `echo npm>>"${log}"\r\nexit /b 0`);
        if (scenario === "npm present") cmd("npm", `echo npm>>"${log}"\r\nexit /b 0`);
        if (scenario !== "winget missing") cmd("winget", `echo winget>>"${log}"\r\ncopy /y "${join(dir, "staged-npm.cmd")}" "${join(dir, "npm.cmd")}" >nul\r\nexit /b ${scenario === "winget failure" ? 8 : 0}`);
        const npm = scenario.startsWith("winget") || scenario.startsWith("npm");
        const command = scenario === "installer exit" ? "Write-Output 'installer-output'; Invoke-Expression 'exit 7'"
          : scenario.startsWith("irm") ? `function Invoke-RestMethod { '${scenario === "irm failure" ? "Write-Error stub-failure" : "install"}' }\nirm https://stub.invalid/install.ps1 | iex`
            : npm ? "npm install -g stub" : "install";
        const script = terminal.buildInstallScript({ command, needsNode: true, signInCommand: "signin", driverKind: "codex" }, "win32");
        // Keep PATH refresh on the stub tools.
        const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
        const harness = `class Environment { static [string] GetEnvironmentVariable([string] $name, [string] $target) { return $env:WINK_TEST_PATH } }\n$env:Path=${quote(`${dir};${powershell}`)}\n& {\n${script}\n}\nWrite-Output 'parent-alive'`;
        const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")], {
          encoding: "utf8", windowsHide: true, timeout: 30000,
          env: { ...process.env, WINK_TEST_PATH: `${dir};${bin};${powershell}` },
        });
        assert.ifError(result.error);
        const calls = (() => { try { return readFileSync(log, "utf8").trim().split(/\r?\n/); } catch { return []; } })();
        const expected = scenario === "success" || scenario === "irm success" ? ["install", "signin"]
          : scenario === "failure" ? ["install"]
            : scenario === "npm present" ? ["npm", "signin"]
              : scenario === "npm missing" ? ["winget", "npm", "signin"]
                : scenario === "winget failure" ? ["winget"] : [];
        assert.deepEqual(calls, expected, `${result.stdout}\n${result.stderr}`);
        if (["success", "installer exit"].includes(scenario)) assert.match(result.stdout, /parent-alive/);
        if (scenario === "installer exit") assert.match(result.stdout, /installer-output/);
        if (["winget missing", "irm failure"].includes(scenario)) assert.ok(result.stderr, "PowerShell error stays visible");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
