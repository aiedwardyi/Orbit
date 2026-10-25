# Bot switch

## Sub-features

- Desktop: the sidebar lists every bot; a click opens its chat and marks the row current.
- Phone: the menu button opens the drawer over the chat; a tap opens the bot and closes the drawer.
- The chat header, the composer placeholder and the transcript all follow the switch.

## How to get there

- Desktop: the sidebar on the left is always open at 1440 wide.
- Phone: tap the menu button in the top corner of the chat (`Open bot list`).

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Orion/]'
$C expect switched visible 'role=log[name="Conversation with Orion"]'
$C expect composer count 'textarea[placeholder="Message Orion"]' 1
$C shot bot-switch-desktop

$C open phone
$C click 'role=button[name="Open bot list"]'
$C expect drawer in-view 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Vega/]'
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Vega/]'
$C expect switched visible 'role=log[name="Conversation with Vega"]'
$C expect closed count '[data-phone-menu][aria-expanded="false"]' 1
$C shot bot-switch-phone
```

## Proof

- `switched`: the conversation log is named for the new bot.
- `composer`: the composer placeholder names it too, so the composer sends to the bot on screen.
- Phone adds `drawer` (the tap target was on screen) and `closed` (the drawer got out of the way).
- A send after the switch (see [send-reply](send-reply.md)) gets that bot's engine tag in the reply, which proves the switch reached the server.

## Gotchas

- Bot rows are `div[role=button]` with no label; their name is the row text (name, title, preview). Pin it with `name=/^Name/`, and run `snapshot --selector 'aside[aria-label="Bots and navigation"]'` when a row will not match.
- The phone drawer is the same `aside` as the desktop sidebar, translated off screen when closed. Playwright still calls it visible, so check `in-view` or the menu button's `aria-expanded`, never `visible` or `hidden`.
- The menu button's name grows when something needs you (`Open bot list, a bot has a question`, `Open bot list, a routine rang`), and a quoted name must match whole. Use `name=/^Open bot list/` when one may be pending.
- The drawer slides; `expect` polls, so do not add sleeps.

## Last proven

6ffd674e (review-base), 2026-10-25: desktop (Orion) and phone (Vega) PASS. Evidence `evidence/2026-10-25T13-54-48-6ffd674`.
