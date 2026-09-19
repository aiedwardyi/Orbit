import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const GRANT_PREFIX = "orbit-mailbox-v1";
const SECRET_RE = /^[a-f0-9]{64}$/;

/** The server writes it at boot; null until then so the pane opens without orbit-msg. */
export async function readMailboxSecret(dir) {
  const secret = (await fs.readFile(path.join(dir, "mailbox-secret"), "utf8").catch(() => "")).trim();
  return SECRET_RE.test(secret) ? secret : null;
}

/** Scoped to one pane/bot/teacher triple so a pane can only post as itself. */
export function mailboxGrant(token, pane, bot, teacher) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || ![pane, bot, teacher].every((id) => typeof id === "string" && ID_RE.test(id))) {
    throw new Error("Invalid mailbox grant");
  }
  const keyId = createHash("sha256").update(`${GRANT_PREFIX}:key:${token}`).digest("hex").slice(0, 8);
  return `${keyId}.${createHmac("sha256", token).update(`${GRANT_PREFIX}:${pane}:${bot}:${teacher}`).digest("base64url")}`;
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
// No .cmd shim: cmd.exe re-parses its command line, so args could run commands.
const ORBIT_MSG_PS1 = String.raw`$ErrorActionPreference = 'Stop'
$mode = if ($args.Count -ge 2 -and ($args[0] -eq '--hook' -or $args[0] -eq '--notify')) { $args[0] }
if (-not $env:ORBIT_PANE -or -not $env:ORBIT_URL -or -not $env:ORBIT_MSG_TOKEN) {
  if ($mode) { exit 0 }
  [Console]::Error.WriteLine('orbit-msg: not inside an Orbit terminal pane')
  exit 1
}
if ([Console]::IsInputRedirected) { try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {} }
if ($mode -eq '--hook') {
  $text = [string](([Console]::In.ReadToEnd() | ConvertFrom-Json).($args[1]))
} elseif ($mode) {
  # Codex notify appends its JSON as one argv and spawns us directly, so no shell re-parses it.
  $text = [string](($args[$args.Count - 1] | ConvertFrom-Json).($args[1]))
} elseif ($args.Count) {
  $text = $args -join ' '
} else {
  # Get-Variable, not a literal $input: that makes powershell -File swallow stdin first.
  $text = (Get-Variable -Name input -ValueOnly | ForEach-Object { $_ }) -join "` + "`" + String.raw`n"
  if (-not $text -and [Console]::IsInputRedirected) { $text = [Console]::In.ReadToEnd() }
}
if (-not $text.Trim()) {
  if ($mode) { exit 0 }
  [Console]::Error.WriteLine('usage: orbit-msg "text"')
  exit 1
}
$max = 8000
do {
  $clip = if ($text.Length -gt $max) { $text.Substring(0, $max) + "` + "`" + String.raw`n[truncated]" } else { $text }
  $body = [Text.Encoding]::UTF8.GetBytes((@{ text = $clip } | ConvertTo-Json -Compress))
  $max = [int]($max / 2)
} while ($body.Length -gt 16000)
$headers = @{ Authorization = "Bearer $env:ORBIT_MSG_TOKEN"; 'X-Orbit-Pane' = $env:ORBIT_PANE; 'X-Orbit-Bot' = $env:ORBIT_BOT; 'X-Orbit-Teacher' = $env:ORBIT_TEACHER }
try {
  Invoke-RestMethod -Method Post -Uri "$env:ORBIT_URL/api/mailbox" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10 | Out-Null
} catch {
  $failure = $_
  if ($failure.Exception.Message -match 'timed out') {
    [Console]::Error.WriteLine('orbit-msg: Orbit did not answer in 10s')
    exit 1
  }
  # Windows PowerShell leaves ErrorDetails empty; the server's reason is still on the response stream.
  $detail = $failure.ErrorDetails.Message
  if (-not $detail) { $detail = try { (New-Object IO.StreamReader($failure.Exception.Response.GetResponseStream())).ReadToEnd() } catch { $null } }
  $reason = try { ($detail | ConvertFrom-Json).error } catch { $null }
  [Console]::Error.WriteLine("orbit-msg: $(if ($reason) { $reason } else { $failure.Exception.Message })")
  exit 1
}
`;

/** Writes orbit-msg into `dir`; Windows only, returns null elsewhere. */
export async function installOrbitMsg(dir, platform = process.platform) {
  if (platform !== "win32") return null;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "orbit-msg.ps1"), ORBIT_MSG_PS1.replace(/\r?\n/g, "\r\n"));
  await Promise.all(["orbit-msg.cmd", "orbit-mailbox.ps1"].map((stale) => fs.rm(path.join(dir, stale), { force: true })));
  return dir;
}
