import { createHash, createHmac, randomUUID } from "node:crypto";
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

/** Posts as the pane itself, so the note takes orbit-msg's route to the teacher. */
export async function postPaneNote(mailbox, { pane, bot, teacher }, text, fetchImpl = fetch) {
  const response = await fetchImpl(`${mailbox.url}/api/mailbox`, {
    method: "POST",
    headers: { authorization: `Bearer ${mailboxGrant(mailbox.token, pane, bot, teacher)}`, "content-type": "application/json", "x-orbit-pane": pane, "x-orbit-bot": bot, "x-orbit-teacher": teacher },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Mailbox post failed: ${response.status}`);
}

export function terminalPaneEnv(base, { pane, bot, teacher = bot, mailbox = null }) {
  const env = { ...base, ORBIT_PANE: pane, ORBIT_BOT: bot, ORBIT_TEACHER: teacher };
  if (!mailbox) return env;
  env.ORBIT_URL = mailbox.url;
  env.ORBIT_MSG_AUTH = mailboxGrant(mailbox.token, pane, bot, teacher);
  if (mailbox.binDir) {
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[key] = env[key] ? `${mailbox.binDir}${path.delimiter}${env[key]}` : mailbox.binDir;
  }
  return env;
}

// Exit 1, never 2: a Claude Code Stop hook treats exit 2 as "keep working".
// The .cmd and extensionless shims forward argv here; this script holds the only logic.
const ORBIT_MSG_PS1 = String.raw`$ErrorActionPreference = 'Stop'
$mode = if ($args.Count -ge 2 -and ($args[0] -eq '--hook' -or $args[0] -eq '--notify')) { $args[0] }
if ($args.Count -ge 1 -and @('--help', '-h', '/?') -contains $args[0]) {
  [Console]::Out.WriteLine('usage: orbit-msg "text" | orbit-msg --file <path> | orbit-msg - | orbit-msg --report <DONE|FAIL|BLOCKED> <TASK-NICK> [text]')
  exit 0
}
$auth = if ($env:ORBIT_MSG_AUTH) { $env:ORBIT_MSG_AUTH } else { $env:ORBIT_MSG_TOKEN }
if (-not $env:ORBIT_PANE -or -not $env:ORBIT_URL -or -not $auth) {
  if ($mode) { exit 0 }
  [Console]::Error.WriteLine('orbit-msg: not inside a Wink terminal pane')
  exit 1
}
$report = $null
if ($args.Count -ge 1 -and $args[0] -eq '--report') {
  if ($args.Count -lt 3 -or @('DONE','FAIL','BLOCKED') -notcontains $args[1] -or [string]::IsNullOrWhiteSpace($args[2])) {
    [Console]::Error.WriteLine('usage: orbit-msg --report <DONE|FAIL|BLOCKED> <TASK-NICK> [text|--file <path>|-]')
    exit 1
  }
  $report = @{ status = $args[1]; nick = ($args[2] -replace '\s+', '_') }
}
if ([Console]::IsInputRedirected) { try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {} }
function Read-OrbitFile([string]$Path) {
  if (-not $Path) {
    [Console]::Error.WriteLine('orbit-msg: --file needs a path')
    exit 1
  }
  try {
    return [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding $false))
  } catch {
    [Console]::Error.WriteLine("orbit-msg: cannot read file $Path")
    exit 1
  }
}
function Read-OrbitStdin {
  # Get-Variable, not a literal $input: that makes powershell -File swallow stdin first.
  # -Scope Script: a function's own automatic input is empty. The pipeline is on the script.
  try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {}
  $text = (Get-Variable -Name input -Scope Script -ValueOnly -ErrorAction SilentlyContinue | ForEach-Object { $_ }) -join ([string][char]10)
  if (-not $text -and [Console]::IsInputRedirected) { $text = [Console]::In.ReadToEnd() }
  return $text
}
function Get-OrbitMessage {
  # A splatted range arrives as one nested array. Flatten once or -join prints System.Object[].
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($a in $args) {
    if ($null -ne $a -and $a -is [System.Array]) { foreach ($x in $a) { [void]$parts.Add([string]$x) } }
    else { [void]$parts.Add([string]$a) }
  }
  if ($parts.Count -eq 0) { return (Read-OrbitStdin) }
  if ($parts.Count -eq 1 -and ($parts[0] -eq '-' -or $parts[0] -eq '--stdin')) { return (Read-OrbitStdin) }
  if ($parts -contains '--file') {
    if ($parts.Count -ne 2 -or $parts[0] -ne '--file') {
      [Console]::Error.WriteLine('orbit-msg: --file needs one path and no other message text')
      exit 1
    }
    return (Read-OrbitFile $parts[1])
  }
  return ($parts -join ' ')
}
if ($report) {
  if ($args.Count -gt 3) {
    $rest = @($args[3..($args.Count - 1)])
    $text = Get-OrbitMessage @rest
  } else { $text = Get-OrbitMessage }
  $branch = 'none'; $sha = 'none'; $dirty = 'unknown'
  # Repo config can run fsmonitor or hooks; neither may see the pane grant.
  $paneVars = @('ORBIT_PANE', 'ORBIT_BOT', 'ORBIT_TEACHER', 'ORBIT_URL', 'ORBIT_MSG_AUTH', 'ORBIT_MSG_TOKEN')
  $saved = @{}
  foreach ($name in $paneVars) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $null) }
  try {
    $b = git -c core.fsmonitor=false -c core.hooksPath=NUL rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1
    $s = git -c core.fsmonitor=false -c core.hooksPath=NUL rev-parse --short HEAD 2>$null | Select-Object -First 1
    if ($b -and $s) {
      $branch = ([string]$b).Trim() -replace '\s+', '_'
      $sha = ([string]$s).Trim() -replace '\s+', '_'
      $dirty = if (git -c core.fsmonitor=false -c core.hooksPath=NUL status --porcelain 2>$null | Select-Object -First 1) { 'yes' } else { 'no' }
    }
  } catch {} finally {
    foreach ($name in $paneVars) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  }
  $header = "$($report.status) $($report.nick) branch=$branch sha=$sha dirty=$dirty"
  $text = if ($text.Trim()) { "$header` + "`" + String.raw`n$text" } else { $header }
} elseif ($mode -eq '--hook') {
  $text = [string](([Console]::In.ReadToEnd() | ConvertFrom-Json).($args[1]))
} elseif ($mode) {
  # Codex notify appends its JSON as one argv and spawns us directly, so no shell re-parses it.
  # Codex also notifies other events and title-naming turns; only a real agent-turn-complete message is a report.
  $event = $args[$args.Count - 1] | ConvertFrom-Json
  $text = if ($event.type -eq 'agent-turn-complete') { [string]($event.($args[1])) } else { '' }
  if ($text.Trim()) {
    try {
      $obj = $text | ConvertFrom-Json -ErrorAction Stop
      if ($obj -is [pscustomobject] -and (@($obj.PSObject.Properties.Name) -join ',') -eq 'title') { $text = '' }
    } catch {}
  }
} elseif ($args.Count) {
  $text = Get-OrbitMessage @args
} else {
  $text = Read-OrbitStdin
}
if (-not $text.Trim()) {
  if ($mode) { exit 0 }
  [Console]::Error.WriteLine('usage: orbit-msg "text"')
  exit 1
}
$max = 8000
do {
  $clip = if ($text.Length -gt $max) { $text.Substring(0, $max) + "` + "`" + String.raw`n[truncated]" } else { $text }
  $payload = @{ text = $clip }
  if ($report) { $payload.kind = 'report' } elseif ($mode) { $payload.kind = 'auto' }
  $body = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
  $max = [int]($max / 2)
} while ($body.Length -gt 16000)
$headers = @{ Authorization = "Bearer $auth"; 'X-Orbit-Pane' = $env:ORBIT_PANE; 'X-Orbit-Bot' = $env:ORBIT_BOT; 'X-Orbit-Teacher' = $env:ORBIT_TEACHER }
$uris = @("$env:ORBIT_URL/api/mailbox")
if ($env:ORBIT_URL -match '^http://127\.0\.0\.1:\d+$') {
  $uris += 'http://127.0.0.1:18799/api/mailbox', 'http://127.0.0.1:28799/api/mailbox'
}
$uris = $uris | Select-Object -Unique
# Loopback only: skip system proxy auto-detect (WPAD), which .NET runs before any bypass rule and can block 30s+.
$direct = if ($PSVersionTable.PSVersion.Major -ge 6) { @{ NoProxy = $true } } else { [Net.WebRequest]::DefaultWebProxy = $null; @{} }
$failure = $null
foreach ($uri in $uris) {
  $failure = $null
  try {
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10 @direct | Out-Null
    break
  } catch {
    $failure = $_
    if ($failure.Exception.Message -notmatch 'Unable to connect|refused') { break }
  }
}
if ($failure) {
  if ($failure.Exception.Message -match 'timed out') {
    [Console]::Error.WriteLine('orbit-msg: Wink did not answer in 10s')
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

// Each argument is stored with %~1 while delayed expansion is off, then
// re-quoted and inserted with delayed expansion on. That happens after cmd
// parses the powershell line, so a quote, pipe or redirect in the text cannot
// split it. powershell -File treats a bare "-" as its own switch, so a lone
// "-" that is the whole message is rewritten. A dash inside other text is not.
const ORBIT_MSG_CMD = String.raw`@echo off
setlocal DisableDelayedExpansion
rem Save the script path first: shift also moves the batch name.
set "ORBIT_MSG_PS1=%~dp0orbit-msg.ps1"
set "N=0"
:orbit_msg_next
if "%~1"=="" goto orbit_msg_run
set /a N+=1 >nul
set "A%N%=%~1"
shift
goto orbit_msg_next
:orbit_msg_run
setlocal EnableDelayedExpansion
rem orbit-msg - , or orbit-msg --report STATUS NICK -
if "%N%"=="1" if "!A1!"=="-" set "A1=--stdin"
if "%N%"=="4" if /I "!A1!"=="--report" if "!A4!"=="-" set "A4=--stdin"
set "ORBIT_MSG_FWD="
for /L %%I in (1,1,!N!) do if defined ORBIT_MSG_FWD (set "ORBIT_MSG_FWD=!ORBIT_MSG_FWD! "!A%%I!"") else (set "ORBIT_MSG_FWD="!A%%I!"")
where pwsh >nul 2>nul
if errorlevel 1 (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "!ORBIT_MSG_PS1!" !ORBIT_MSG_FWD!
) else (
  pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "!ORBIT_MSG_PS1!" !ORBIT_MSG_FWD!
)
`;

const ORBIT_MSG_SH = String.raw`#!/bin/bash
if command -v pwsh.exe >/dev/null 2>&1; then
  ps=pwsh.exe
else
  ps=powershell.exe
fi
script=$(dirname "$0")/orbit-msg.ps1
# powershell -File binds a bare "-" as its own switch and never passes it on.
# Rewrite only a lone "-" that is the whole message.
if [ "$#" -eq 1 ] && [ "$1" = "-" ]; then
  set -- --stdin
elif [ "$#" -eq 4 ] && [ "$1" = "--report" ] && [ "$4" = "-" ]; then
  set -- "$1" "$2" "$3" --stdin
fi
exec "$ps" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$script" "$@"
`;

// Claude Code swaps hook stdout over 10,000 chars for a 2,000-char preview, so each part stays under 9,900.
// "card" prints the first card; "progress" prints follow-up cards, then the card's progress file.
const ORBIT_COMPACT_PS1 = String.raw`$ErrorActionPreference = 'Stop'
$part = [string]$args[0]
$max = 9900
$nl = [string][char]10
$utf8 = New-Object Text.UTF8Encoding $false
function Get-Clip([string]$Text, [int]$Keep, [bool]$Tail) {
  if ($Tail) {
    $start = $Text.Length - $Keep
    if ($start -gt 0 -and [char]::IsLowSurrogate($Text[$start])) { $start += 1 }
    return $Text.Substring($start)
  }
  if ($Keep -gt 0 -and [char]::IsHighSurrogate($Text[$Keep - 1])) { $Keep -= 1 }
  return $Text.Substring(0, $Keep)
}
function Get-Block([string]$Label, [string]$Path, [string]$Text, [int]$Keep, [bool]$Tail) {
  $head = $Label + ': ' + $Path + $nl
  if ($Text.Length -le $Keep) { return $head + $Text }
  $clip = Get-Clip $Text ([Math]::Max(0, $Keep)) $Tail
  if ($Tail) { return $head + '[cut] Read ' + $Path + ' for the start.' + $nl + $clip }
  return $head + $clip + $nl + '[cut] Read ' + $Path + ' for the rest.'
}
try {
  $hook = (New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8)).ReadToEnd() | ConvertFrom-Json
  $cwd = [string]$hook.cwd
  $ask = New-Object Text.RegularExpressions.Regex('^\s*Read\s+"?(.+?\.md)"?\s+and do it')
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $cards = New-Object System.Collections.Generic.List[string]
  $stream = New-Object IO.FileStream([string]$hook.transcript_path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
  $reader = New-Object IO.StreamReader($stream, $utf8, $false, 1048576)
  try {
    # Tool results and summaries can quote a card prompt too; only a message that starts with one counts.
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($line.IndexOf(' and do it', [StringComparison]::Ordinal) -lt 0) { continue }
      # Claude Code writes compact JSONL; these literals assume no space after the colon.
      if ($line.IndexOf('"content":"Read ', [StringComparison]::Ordinal) -lt 0 -and $line.IndexOf('"prompt":"Read ', [StringComparison]::Ordinal) -lt 0 -and $line.IndexOf('"text":"Read ', [StringComparison]::Ordinal) -lt 0) { continue }
      try {
        $o = $line | ConvertFrom-Json
        $text = $null
        if ($o.type -eq 'user') {
          $c = $o.message.content
          $text = if ($c -is [string]) { $c } else { @($c | Where-Object { $_.type -eq 'text' } | ForEach-Object { [string]$_.text })[0] }
        } elseif ($o.type -eq 'attachment' -and $o.attachment.type -eq 'queued_command') {
          $text = [string]$o.attachment.prompt
        }
        $m = $ask.Match([string]$text)
        if (-not $m.Success) { continue }
        $card = $m.Groups[1].Value
        if ($cwd) { $card = [IO.Path]::Combine($cwd, $card) }
        if ($seen.Add($card)) { [void]$cards.Add($card) }
      } catch {}
    }
  } finally { $reader.Dispose() }
  if ($cards.Count -eq 0) { exit 0 }
  $card = $cards[0]
  $cardText = [IO.File]::ReadAllText($card, $utf8)
  if ($part -eq 'card') {
    $out = 'Context was just compacted. Your card follows word for word; its follow-ups and progress file come in a second note.' + $nl + $nl
    $cut = '[cut] Read ' + $card + ' for the rest.'
    $out += Get-Block 'Card' $card $cardText ($max - $out.Length - ('Card: ' + $card).Length - $cut.Length - 2) $false
  } elseif ($part -eq 'progress') {
    $out = 'Context was just compacted. The follow-ups and progress file for ' + $card + ' follow word for word.'
    foreach ($follow in ($cards | Select-Object -Skip 1)) {
      try { $text = [IO.File]::ReadAllText($follow, $utf8) } catch { continue }
      $block = Get-Block 'Follow-up' $follow $text 1000 $false
      if ($out.Length + $block.Length -gt 6000) { $block = 'Follow-up: ' + $follow + $nl + '[cut] Read ' + $follow + ' for the rest.' }
      $out += $nl + $nl + $block
    }
    $progress = Join-Path (Split-Path $card) ([IO.Path]::GetFileNameWithoutExtension($card) + '.progress.md')
    $text = try { [IO.File]::ReadAllText($progress, $utf8) } catch { $null }
    if ($null -eq $text) {
      $out += $nl + $nl + 'Progress: ' + $progress + $nl + 'No progress file yet.'
    } else {
      $out += $nl + $nl
      $cut = '[cut] Read ' + $progress + ' for the start.'
      $out += Get-Block 'Progress' $progress $text ($max - $out.Length - ('Progress: ' + $progress).Length - $cut.Length - 2) $true
    }
  } else { exit 0 }
  $bytes = $utf8.GetBytes($out)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} catch {}
exit 0
`;

const WAITING_NOTE = "WAITING: this worker is stuck on an on-screen prompt (permission check or question). terminal_read its pane, then answer with key presses or tell the user.";

// permission_prompt also fires for AskUserQuestion; idle_prompt would repeat after every finished turn.
// A plain note, not --hook: the report dedup can swallow an auto note.
// Compacts at about 267k (window minus 33k), well before the 1M default.
function claudeWorkerSettings(dir) {
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(dir, "orbit-msg.ps1").replace(/\\/g, "/")}" "${WAITING_NOTE}"`;
  const compact = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(dir, "orbit-compact.ps1").replace(/\\/g, "/")}"`;
  return `${JSON.stringify({
    autoCompactWindow: 300_000,
    hooks: {
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command, timeout: 15 }] }],
      SessionStart: [{ matcher: "compact", hooks: ["card", "progress"].map((part) => ({ type: "command", command: `${compact} ${part}`, timeout: 30 })) }],
    },
  }, null, 2)}\n`;
}

/** Writes orbit-msg and the Claude worker hook settings into `dir`; Windows only, returns null elsewhere. */
export async function installOrbitMsg(dir, platform = process.platform) {
  if (platform !== "win32") return null;
  await fs.mkdir(dir, { recursive: true });
  const files = [
    ["orbit-msg.ps1", ORBIT_MSG_PS1.replace(/\r?\n/g, "\r\n")],
    ["orbit-msg.cmd", ORBIT_MSG_CMD.replace(/\r?\n/g, "\r\n")],
    ["orbit-msg", ORBIT_MSG_SH],
    ["orbit-compact.ps1", ORBIT_COMPACT_PS1.replace(/\r?\n/g, "\r\n")],
    ["claude-worker.json", claudeWorkerSettings(dir)],
  ];
  for (const [name, content] of files) {
    const target = path.join(dir, name);
    if ((await fs.readFile(target, "utf8").catch(() => null)) !== content) {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, content);
      try {
        await fs.rename(tmp, target);
      } catch (error) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
    }
  }
  await fs.rm(path.join(dir, "orbit-mailbox.ps1"), { force: true });
  return dir;
}
