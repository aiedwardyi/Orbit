# Phone and desktop live sync

## Sub-features

- A message sent on one device lands on the other without a reload, and so does the reply.
- Busy state follows: the other device shows the turn running and settling.
- Both devices keep one order; nothing doubles.

## How to get there

- Wink on the desktop and on the phone, signed in to the same server, both on the same bot. Here: two pages from one launch, each with its own browser context, both talking to the one server over its live events.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop && $C open phone
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Lyra/]' --page desktop
$C click 'role=button[name="Open bot list"]' --page phone
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Lyra/]' --page phone

$C expect both-on-lyra visible 'role=log[name="Conversation with Lyra"]' --page phone
$C type 'textarea[data-orbit-composer]' "from phone" --page phone
$C click 'role=button[name="Send message"]' --page phone
$C expect phone-to-desktop text '[data-orbit-message="user"] >> nth=-1' "from phone" --page desktop
$C wait-settle --text "re: from phone" --page desktop
$C expect reply-on-desktop text '[data-orbit-message="bot"] >> nth=-1' "STUB MUSE" --page desktop

$C type 'textarea[data-orbit-composer]' "from desktop" --page desktop
$C press Enter --selector 'textarea[data-orbit-composer]' --page desktop
$C expect desktop-to-phone text '[data-orbit-message="user"] >> nth=-1' "from desktop" --page phone
$C wait-settle --text "re: from desktop" --page phone
$C expect reply-on-phone text '[data-orbit-message="bot"] >> nth=-1' "re: from desktop" --page phone
$C expect once count '[data-orbit-message="user"]:has-text("from phone")' 1 --page desktop
$C expect once count '[data-orbit-message="user"]:has-text("from phone")' 1 --page phone
$C expect once count '[data-orbit-message="user"]:has-text("from desktop")' 1 --page desktop
$C expect once count '[data-orbit-message="user"]:has-text("from desktop")' 1 --page phone
$C expect once count '[data-orbit-message="bot"]:has-text("re: from phone")' 1 --page desktop
$C expect once count '[data-orbit-message="bot"]:has-text("re: from phone")' 1 --page phone
$C expect once count '[data-orbit-message="bot"]:has-text("re: from desktop")' 1 --page desktop
$C expect once count '[data-orbit-message="bot"]:has-text("re: from desktop")' 1 --page phone
$C shot live-sync-desktop --page desktop && $C shot live-sync-phone --page phone
```

## Proof

- `phone-to-desktop` and `desktop-to-phone`: the other page shows the message with no reload in between.
- `both-on-lyra`: the phone has the same chat open.
- `reply-on-desktop`: the reply to the phone's message reaches the desktop, engine tag and quote included. `reply-on-phone` is the same the other way.
- `once`: no duplicate bubble after the round trip.
- Shots of both pages at the end, taken after both settled.

## Gotchas

- Never `reload` mid-proof; it turns live sync into a fetch.
- On a phone, Enter adds a line. Send with the `Send message` button.
- Each `open` gets its own context, so localStorage, drafts and the drawer are per page, as on two devices. The server, data dir and live events are shared.
- Use a fresh bot or fresh text per run; seeded history and earlier runs hold other user bubbles.
- One server stands in for both devices. Phone access through the relay or Tailscale is off in the kit, so the remote path is a gap; this covers the shared server and its live events.

## Last proven

0ab2d63d (review-base), 2026-10-25: both directions PASS between a desktop and a phone page on Lyra, each message and each reply once on both pages. Evidence `evidence/2026-10-25T19-26-57-0ab2d63`.
