import { execFile } from "node:child_process";
import { createServer } from "node:http";

const live = createServer((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
await new Promise((r) => live.listen(0, "127.0.0.1", r));
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const closedPort = probe.address().port;
await new Promise((r) => probe.close(r));
const url = `http://127.0.0.1:${live.address().port}/`;
const closed = `http://127.0.0.1:${closedPort}/`;

const sw = (label, body) => `$sw = [Diagnostics.Stopwatch]::StartNew(); try { ${body} } catch { $m = $_.Exception.Message }; [Console]::Out.WriteLine("  ${label}: " + $sw.ElapsedMilliseconds + "ms " + $m); $m = $null`;
const cmds = {
  noop: "exit 0",
  getvar: sw("getvar", "Get-Variable -Name x -ErrorAction SilentlyContinue | Out-Null"),
  json: sw("json", "@{a=1} | ConvertTo-Json | Out-Null"),
  irmLive: sw("irmLive", `Invoke-RestMethod -Method Post -Uri '${url}' -Body 'x' -TimeoutSec 10 | Out-Null`),
  irmLiveTwice: sw("first", `Invoke-RestMethod -Method Post -Uri '${url}' -Body 'x' -TimeoutSec 10 | Out-Null`) + "; " + sw("second", `Invoke-RestMethod -Method Post -Uri '${url}' -Body 'x' -TimeoutSec 10 | Out-Null`),
  irmLiveNoProxy: sw("setproxy", "[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy") + "; " + sw("irm", `Invoke-RestMethod -Method Post -Uri '${url}' -Body 'x' -TimeoutSec 10 | Out-Null`),
  getProxy: sw("getProxy", `$m = [Net.WebRequest]::DefaultWebProxy.GetProxy([Uri]'${url}').AbsoluteUri`),
  irmClosed: sw("irmClosed", `Invoke-RestMethod -Method Post -Uri '${closed}' -Body 'x' -TimeoutSec 10 | Out-Null`),
  irmClosedNoProxy: "[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy; " + sw("irmClosed", `Invoke-RestMethod -Method Post -Uri '${closed}' -Body 'x' -TimeoutSec 10 | Out-Null`),
  tcpClosed: sw("tcpClosed", `(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', ${closedPort})`),
  fileFresh: "__FILE__",
  info: "[Console]::Out.WriteLine('PSModulePath=' + $env:PSModulePath); [Console]::Out.WriteLine('modules=' + @(Get-Module -ListAvailable).Count)",
};
const envs = { bare: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, full: process.env };
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "diag-"));
let n = 0;
function run(env, c) {
  let args = ["-Command", c];
  if (c === "__FILE__") {
    const f = join(dir, `s${n++}.ps1`);
    writeFileSync(f, cmds.irmLive.replace("irmLive", "fileIrm"));
    args = ["-File", f];
  }
  return new Promise((resolve) => {
    const t = Date.now();
    execFile("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { env, encoding: "utf8", windowsHide: true },
      (_e, stdout, stderr) => resolve(`${Date.now() - t}ms total\n${stdout.trimEnd()}${stderr ? `\n  stderr: ${stderr.trim().slice(0, 200)}` : ""}`));
  });
}
for (let round = 1; round <= 2; round++) for (const [en, env] of Object.entries(envs)) for (const [cn, c] of Object.entries(cmds)) {
  console.log(`[r${round} ${en} ${cn}] ${await run(env, c)}`);
}
live.close();
