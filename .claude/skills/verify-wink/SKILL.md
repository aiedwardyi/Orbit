---
name: verify-wink
description: Use when a Wink feature or fix needs proof the way a user drives it, in Wink's web UI on desktop (1440x900) and phone (390x844, touch), from this or any other checkout, without touching the running Wink, its data or its ports. Use it instead of writing a one-off Playwright kit.
---

# Verify Wink

`control-wink.mjs` builds a checkout's UI and server into a scratch root, starts them on a free port in 8970-8979 with stub engine CLIs, and drives the pages with Playwright like a user. Every command prints one short line. Proofs print `PASS` or `FAIL`.

```bash
node .claude/skills/verify-wink/control-wink.mjs --help
```

## Setup

- Playwright is not a repo dependency. Install it once outside the repo, point `PLAYWRIGHT` at the package and install browsers with that package's own CLI, so their versions match: `npm i -g playwright`, `PLAYWRIGHT="$(npm root -g)/playwright"`, then `node "$PLAYWRIGHT/cli.js" install chromium webkit`. Browsers come from `PLAYWRIGHT_BROWSERS_PATH`, else `%LOCALAPPDATA%\ms-playwright`.
- `WINK_VERIFY_ROOT` picks the scratch root (default `%TEMP%\wink-verify`). One root per agent; two launches cannot share one.
- Windows only for now: `doctor` and `cleanup` read the process table through PowerShell CIM.

## Launch

```bash
node .claude/skills/verify-wink/control-wink.mjs launch                          # the checkout holding this skill
node .claude/skills/verify-wink/control-wink.mjs launch --checkout ../other-tree  # any checkout, read-only
```

- Vite builds the checkout's UI into `<root>/ui` (runner config loader, cache in scratch). The checkout's `git status --short` must not change, or launch fails.
- The server runs from source (`node server/index.ts`) with `OMB_DATA_DIR`, HOME, APPDATA and TEMP inside the root, a fresh `OMB_COMMS_TOKEN`, and remote access, relay, WSL and thread sync v2 off.
- `stub-engine.cjs` answers as claude, codex, grok, antigravity and muse at the CLI boundary. Replies read `STUB <ENGINE> <model> | re: <last prompt line> | <n> image`.
- Every process the kit starts preloads `hidden.cjs`: children spawn hidden, `wsl`, `bash`, `docker`, `podman`, `tailscale` and `cmdkey` are refused, and every spawn is logged.
- Ready means the desktop page lists the server's bots, not just an open port: `launch ready <s>s`.

## Doctor

Run `doctor` after launch and before trusting a proof. It is read-only and checks: our PIDs are alive with our command lines, the port belongs to our server, the served build sha equals the checkout HEAD, the checkout status is unchanged, the data dir is in scratch and not `~/.orbit`, every engine points at the stub, and the spawn log (`denied: cmdkey.exe` is normal: Antigravity's sign-in probe). The last line is `PASS doctor` or `FAIL doctor`.

## Drive

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C seed                                             # Atlas claude, Juno codex, Orion grok, Vega antigravity, Lyra muse; 320 messages on Atlas
$C open desktop && $C open phone                    # one page per name; --engine webkit for Safari
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]' --page desktop
$C type 'textarea[data-orbit-composer]' "hello" --page desktop && $C press Enter --page desktop
$C wait-settle --page desktop
$C expect reply text '[data-orbit-message="bot"] >> nth=-1' "STUB CODEX" --page desktop
```

- `--page <name>` picks the page (default: the last one used). Driving two pages at once is how live sync is proven.
- `click` taps on phone pages. On a phone, Enter in the composer adds a line; send with `role=button[name="Send message"]`.
- `scroll` wheels on desktop and swipes on phone Chromium. It prints the row on top before its last step, so `expect in-view` can prove a load kept your place.
- One browser per engine stays up between commands (Playwright `launchServer` + `connect`), so pages keep their state.
- `eval` only reads. It refuses DOM writes and synthetic input; drive with `click`, `type`, `press`.
- Selectors are Playwright selectors. ARIA roles and labels first, then the app's `data-*` hooks. The shared ones live in [references/features/README.md](references/features/README.md).

## Evidence

Each launch writes `<root>/evidence/<time>-<sha7>/`:

- `steps.log`: every line the driver printed. `proofs.log`: the PASS/FAIL lines.
- `shots/` plus `shots.jsonl` from `shot <name>`. End names with `-desktop` or `-phone` so `sheet` pairs them.
- `sheet.png` from `sheet`: desktop and phone side by side with big labels.
- `server.log`, `browser-*.log`, `build.log`, `spawns.jsonl` (every child process), `stubs.jsonl` (every prompt the engines saw).

## Cleanup

```bash
node .claude/skills/verify-wink/control-wink.mjs cleanup
```

Stops only what this kit started, matched by PID and command line, never by name: a stop file first, then a kill for stragglers. It removes the scratch entries it created, keeps `evidence/`, and prints what it removed and kept.

## Helpers

- `control-wink.mjs`: the driver.
- `stub-engine.cjs`: one stand-in for the five engine CLIs. `WINK_STUB_DELAY_MS` sets the reply delay (default 300).
- `hidden.cjs`: the spawn preload.
- [references/features/](references/features/README.md): how to reach, drive and prove each daily path.
