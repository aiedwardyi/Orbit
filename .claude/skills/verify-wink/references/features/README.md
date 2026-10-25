# Wink feature map

How to reach, drive and prove the paths a daily user takes, in the web UI on desktop and phone. Agents use it to pick what to drive and what counts as proof. Humans use it as the regression checklist.

## Baseline preconditions

- `launch` from the checkout under test, then `doctor` reads `PASS doctor`. A proof against another build or a stale scratch root is not evidence.
- `seed` once per launch: five bots on five engines (Atlas claude, Juno codex, Orion grok, Vega antigravity, Lyra muse) and 320 messages on Atlas.
- Pages: `open desktop` (Chromium 1440x900) and `open phone` (390x844, touch, DPR 3). Add `open phone --engine webkit` when the change touches Safari behavior.
- Engines are stubs. A reply proves the turn crossed the real server and driver into the CLI boundary and back, not that a model is good.
- At the default `WINK_STUB_DELAY_MS` no stub holds a turn open long enough to drive the Stop button. The Muse stub answers `turn/cancel` and `turn/interrupt` requests with a cancelled `turn/completed`, but Wink's Stop sends `turn/interrupt` as a notification, which the stub drops.

## Proof rules

- Drive the path the user takes: visible controls, the registered keys, the app's own API for seeding. `eval` reads state after the user path ran; it never drives.
- Every proof is an `expect` line with a name, so `proofs.log` holds a PASS or FAIL per claim. Pair it with a `shot` of the end state on each form factor the change touches.
- Wait on end states with `wait-settle` or `expect` (it polls for 5 s), never fixed sleeps.
- Prove side effects, not pixels: a reload, a switch away and back, the other page, or the reply text the stub echoes.
- A path the driver cannot reach (Electron-only: terminal panes, device windows, native menus and dialogs) is named as a gap, with the closest real path covered.
- Finish with `sheet`, then `cleanup`. The evidence dir survives cleanup; quote it in the report.

## Selector rules

- ARIA first: `role=button[name="Open bot list"]`, `role=dialog[name="Choose model"]`, `role=textbox[name="Name"]`. A quoted name must match the whole name, ignoring case: `name="Send"` misses `Send message`. Use a regex like `name=/^Juno/` for a prefix and `"..."s` for exact case.
- Then the app's `data-*` hooks. Class names are a last resort; they change with styling.
- Scope repeated controls to their region, for example `aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]`.
- `snapshot --selector <region>` shows the live names before you write a selector.

| Thing | Selector |
|---|---|
| Sidebar (desktop) / drawer (phone) | `aside[aria-label="Bots and navigation"]` |
| Bot row | `aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]` |
| Open the phone drawer | `role=button[name="Open bot list"]`, or `name=/^Open bot list/` while a question or routine is pending (`[data-phone-menu]`, `aria-expanded`) |
| Composer | `textarea[data-orbit-composer]` (placeholder `Message <bot>`) |
| Send (only once the composer has text) | `role=button[name="Send message"]`, or `press Enter` in the composer on desktop (on a phone Enter adds a line) |
| Stop (only while a turn runs) | `role=button[name="Stop this turn"]` |
| Attach | `role=button[name="Attach a file"]` |
| Messages | `[data-orbit-message="user"]`, `[data-orbit-message="bot"]`, rows `[data-mid]` (`display: contents`, no box of their own) |
| Transcript scroller | `[data-orbit-transcript]` |
| Conversation log | `role=log[name="Conversation with <bot>"]` |

## Features

- [send-reply](send-reply.md): send a message and get a reply.
- [bot-switch](bot-switch.md): switch bots from the desktop sidebar and the phone drawer.
- [live-sync](live-sync.md): phone and desktop on one server see each other's turns live.
- [older-messages](older-messages.md): scrolling back loads older messages and keeps your place.
- [model-picker](model-picker.md): Alt+M, pick a model, close.
- [bot-details](bot-details.md): edit name, title, job and memory; "Saved"; survives a reload.
- [worker-rows](worker-rows.md): worker launches and reports as rows in chat.
- [phone-attach](phone-attach.md): attach and send an image from the phone.

## Entry contract

Every feature file uses the same H2s: `Sub-features`, `How to get there`, `Driving it`, `Proof`, `Gotchas`, `Last proven`. `Last proven` dates are UTC, like the evidence folder names.
