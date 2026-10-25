# Send a message and get a reply

## Sub-features

- Enter sends; Shift+Enter adds a line. The Send button sends too.
- The user bubble lands at once; the bot turn shows Stop and the presence mascot while it runs.
- The reply settles into a bot bubble, and the pair survives a reload.

## How to get there

- Desktop: pick the bot in the sidebar. The composer sits at the bottom of the chat.
- Phone: tap the menu button (top corner), tap the bot, and the drawer closes onto its chat. Same composer.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]'
$C type 'textarea[data-orbit-composer]' "send-reply desktop"
$C press Enter --selector 'textarea[data-orbit-composer]'
$C expect sent text '[data-orbit-message="user"] >> nth=-1' "send-reply desktop"
$C wait-settle --text "re: send-reply desktop"
$C expect reply text '[data-orbit-message="bot"] >> nth=-1' "STUB CODEX"
$C reload
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]'
$C expect kept text '[data-orbit-message="bot"] >> nth=-1' "re: send-reply desktop"
$C shot send-reply-desktop
```

Phone is the same after `open phone`, `click 'role=button[name="Open bot list"]'` and the bot row, with `-phone` names. Send with `click 'role=button[name="Send message"]'`: on a touch screen Enter adds a line.

## Proof

- `sent`: the last user bubble holds the text.
- `reply`: the last bot bubble starts with the stub's engine tag (`STUB CODEX` for Juno) and quotes the prompt (`re: <text>`), so the turn went through the server and driver to the CLI and back.
- `kept`: after `reload` and picking the bot again, the reply is still its last bot bubble.
- One shot per form factor of the settled pair.

## Gotchas

- Seeded Atlas history ends in bot replies too; always match the reply on your own prompt text, never on "a bot bubble exists".
- `wait-settle` waits for Stop and the mascot to go and the last bubble to stop changing. A reply the stub has not sent yet looks settled for an instant; pass `--text`.
- A reload opens the top sidebar row, not the bot you were on. Pick it again before `kept`.
- Role names match whole and ignore case: `name="Send"` misses `Send message`. Use a regex like `name=/^Juno/` for a prefix.
- The stub quotes the last line of the prompt Wink sent, which can carry Wink's own wrapping above it. Match `re: <text>`, not the whole bubble.

## Last proven

d4e97cfe (review-base), 2026-10-25: desktop (Juno, codex) and phone (Vega, antigravity) PASS `sent`, `reply` and `kept`. Evidence `evidence/2026-10-25T21-12-40-d4e97cf`.
