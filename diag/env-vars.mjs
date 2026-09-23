import { execFile } from "node:child_process";

const bare = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
const pick = (...names) => Object.fromEntries(names.map((n) => [n, process.env[n]]));
const variants = {
  bare,
  LOCALAPPDATA: { ...bare, ...pick("LOCALAPPDATA") },
  PSModulePath: { ...bare, ...pick("PSModulePath") },
  USERPROFILE: { ...bare, ...pick("USERPROFILE") },
  APPDATA: { ...bare, ...pick("APPDATA") },
  ProgramFiles: { ...bare, ...pick("ProgramFiles") },
  LOCALAPPDATA_USERPROFILE: { ...bare, ...pick("LOCALAPPDATA", "USERPROFILE") },
  full: process.env,
};
const cmd = "$sw = [Diagnostics.Stopwatch]::StartNew(); @{a=1} | ConvertTo-Json | Out-Null; [Console]::Out.WriteLine('json ' + $sw.ElapsedMilliseconds + 'ms')";
for (let round = 1; round <= 2; round++) for (const [name, env] of Object.entries(variants)) {
  const out = await new Promise((resolve) => execFile("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
    { env, encoding: "utf8", windowsHide: true }, (_e, stdout, stderr) => resolve((stdout + stderr).trim())));
  console.log(`[r${round} ${name}] ${out}`);
}
console.log("LOCALAPPDATA=" + process.env.LOCALAPPDATA);
