# Scroll back loads older messages

## Sub-features

- A long chat opens on its newest messages.
- Scrolling up near the top loads the next older page, with a spinner row while it loads.
- Your place holds: the message you were reading stays put while older ones land above it.
- It repeats until the first message of the chat.

## How to get there

- Desktop: open a long chat (`seed` gives Atlas 320 messages) and scroll the transcript up with the wheel.
- Phone: the same chat, swiped down to scroll back.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C seed
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Atlas/]'
$C wait-settle
$C eval 'document.querySelectorAll("[data-orbit-transcript] [data-mid]").length'   # N
$C scroll top                                                # ends "on top before the last step <ANCHOR>"
$C expect older count '[data-orbit-transcript] [data-mid]' '>N'
$C expect place in-view '[data-mid="ANCHOR"]'
$C shot older-messages-desktop
```

Phone: `open phone`, open Atlas from the drawer, then the same steps. On phone Chromium `scroll` swipes like a finger, at most half the transcript per step.

## Proof

- `older`: more messages are mounted after scrolling than before, with no click.
- `place`: the row on top of the view just before older rows landed is still in view after they land. A jump to the new top, or anywhere else, pushes it out.
- `scroll top` prints rows and the first row before and after, so a stall reads in the step log.

## Gotchas

- On review-base older pages come only from the `Show earlier messages` button above the first message (`role=button[name=/Show earlier messages/]`). Scrolling alone loads nothing, so `older` fails there by design: that is the eval this kit was proven on. feat/auto-older (abf8a423) loads on scroll and passes.
- auto-older marks the load point with an empty `[data-older-row]` above the list; a spinner shows in it while a page loads.
- auto-older starts a load while the top is still two viewports away, so the oldest row was never on screen when it began. Check the row `scroll` reports, not the first row.
- Rows are `display: contents`, with no box of their own; `expect in-view` measures what a row holds.
- The first view shows a window of the newest messages (120 of 320 on both builds), not all of them. Read `N` from the page, never assume it.
- `scroll top` stops when the first row changes or the scroller stops moving, so one call is one page. Repeat it to walk further back.
- WebKit pages scroll by script (Playwright has no touch scroll there); prove scrolling behavior on Chromium.

## Last proven

- 6ffd674e (review-base), 2026-10-25: `older` FAIL on desktop and phone by design (120 rows before and after, only `Show earlier messages (80 more)`), `place` PASS. Evidence `evidence/2026-10-25T13-54-48-6ffd674`.
- abf8a423 (feat/auto-older), 2026-10-25: `older` PASS on desktop and phone (120 to 200 rows), `place` PASS. Evidence `evidence/2026-10-25T13-58-33-abf8a42`.
