import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const GRANT_PREFIX = "orbit-mailbox-v1";

/** Scoped to one pane/bot/teacher triple so a pane can only post as itself. */
export function mailboxGrant(token, pane, bot, teacher) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || ![pane, bot, teacher].every((id) => typeof id === "string" && ID_RE.test(id))) {
    throw new Error("Invalid mailbox grant");
  }
  return createHmac("sha256", token).update(`${GRANT_PREFIX}:${pane}:${bot}:${teacher}`).digest("base64url");
}

export function terminalPaneEnv(base, { pane, bot, teacher = bot, mailbox = null }) {
  const env = { ...base, ORBIT_PANE: pane, ORBIT_BOT: bot, ORBIT_TEACHER: teacher };
  if (!mailbox) return env;
  env.ORBIT_URL = mailbox.url;
  env.ORBIT_MSG_TOKEN = mailboxGrant(mailbox.token, pane, bot, teacher);
  if (mailbox.binDir) {
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[key] = env[key] ? `${mailbox.binDir}${path.delimiter}${env[key]}` : mailbox.binDir;
  }
  return env;
}

// Exit 1, never 2: a Claude Code Stop hook treats exit 2 as "keep working".
const ORBIT_MSG_PS1 = String.raw`$ErrorActionPreference = 'Stop'
$hook = $args.Count -ge 2 -and $args[0] -eq '--hook'
if (-not $env:ORBIT_PANE -or -not $env:ORBIT_URL -or -not $env:ORBIT_MSG_TOKEN) {
  if ($hook) { exit 0 }
  [Console]::Error.WriteLine('orbit-msg: not inside an Orbit terminal pane')
  exit 1
}
try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {}
if ($hook) {
  $raw = if ($args.Count -ge 3) { $args[2..($args.Count - 1)] -join ' ' } else { [Console]::In.ReadToEnd() }
  $text = [string](($raw | ConvertFrom-Json).($args[1]))
} elseif ($args.Count) {
  $text = $args -join ' '
} elseif ([Console]::IsInputRedirected) {
  $text = [Console]::In.ReadToEnd()
} else {
  $text = ''
}
if (-not $text.Trim()) {
  if ($hook) { exit 0 }
  [Console]::Error.WriteLine('usage: orbit-msg "text"')
  exit 1
}
$body = @{ pane = $env:ORBIT_PANE; bot = $env:ORBIT_BOT; teacher = $env:ORBIT_TEACHER; text = $text } | ConvertTo-Json -Compress
try {
  Invoke-RestMethod -Method Post -Uri "$env:ORBIT_URL/api/mailbox" -Headers @{ Authorization = "Bearer $env:ORBIT_MSG_TOKEN" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
} catch {
  [Console]::Error.WriteLine("orbit-msg: $($_.Exception.Message)")
  exit 1
}
`;

const ORBIT_MSG_CMD = `@echo off\r\npowershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0orbit-mailbox.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n`;

/** Writes orbit-msg into `dir`; Windows only, returns null elsewhere. */
export async function installOrbitMsg(dir, platform = process.platform) {
  if (platform !== "win32") return null;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "orbit-mailbox.ps1"), ORBIT_MSG_PS1.replace(/\r?\n/g, "\r\n"));
  await fs.writeFile(path.join(dir, "orbit-msg.cmd"), ORBIT_MSG_CMD);
  return dir;
}
