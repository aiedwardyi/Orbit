# Stop a running turn

## Sub-features

- Stop (`Stop this turn`) shows in the composer while a turn runs; one press ends the turn.
- The stopped turn posts no reply, not even a late one.
- The bot is free at once: the next message runs as a normal turn.

## How to get there

- Desktop or phone: send a message to a bot and press the square Stop button in the composer before the reply lands.
- Here: a message whose last line has `[hold]` keeps the stub's turn open 15 s. Only the Muse stub (Lyra) answers Stop; Gotchas has the other engines.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop && $C open phone
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Lyra/]' --page desktop
$C click 'role=button[name="Open bot list"]' --page phone
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Lyra/]' --page phone

$C type 'textarea[data-orbit-composer]' "held desktop [hold]" --page desktop
$C press Enter --selector 'textarea[data-orbit-composer]' --page desktop
$C expect running visible 'role=button[name="Stop this turn"]' --page desktop
$C type 'textarea[data-orbit-composer]' "after stop desktop" --page desktop
$C click 'role=button[name="Stop this turn"]' --page desktop
$C press Enter --selector 'textarea[data-orbit-composer]' --page desktop
$C expect freed visible '[data-orbit-message="bot"]:has-text("re: after stop desktop")' --timeout 2500 --page desktop

$C type 'textarea[data-orbit-composer]' "held phone [hold]" --page phone
$C click 'role=button[name="Send message"]' --page phone
$C expect running visible 'role=button[name="Stop this turn"]' --page phone
$C type 'textarea[data-orbit-composer]' "after stop phone" --page phone
$C click 'role=button[name="Stop this turn"]' --page phone
$C click 'role=button[name="Send message"]' --page phone
$C expect freed visible '[data-orbit-message="bot"]:has-text("re: after stop phone")' --timeout 2500 --page phone

sleep 17                                            # past the stub's 15 s hold on both held sends
$C expect no-late-reply count '[data-orbit-message="bot"]:has-text("re: held desktop")' 0 --page desktop
$C expect no-late-reply count '[data-orbit-message="bot"]:has-text("re: held desktop")' 0 --page phone
$C expect no-late-reply count '[data-orbit-message="bot"]:has-text("re: held phone")' 0 --page desktop
$C expect no-late-reply count '[data-orbit-message="bot"]:has-text("re: held phone")' 0 --page phone
$C expect once count '[data-orbit-message="bot"]:has-text("re: after stop desktop")' 1 --page desktop
$C expect once count '[data-orbit-message="bot"]:has-text("re: after stop phone")' 1 --page phone
$C shot stop-desktop --page desktop && $C shot stop-phone --page phone
```

## Proof

- `running`: Stop shows while the held turn runs.
- `freed`: a plain message sent about a second after the click is answered within 3 s of sending. Wink queues a send until the driver lets go of the stopped turn, which the Muse driver does when the engine confirms the cancel, or else after its 5 s grace. This is the check that fails when the engine ignores Stop.
- `no-late-reply`: once the hold has passed, neither page shows a reply to either held message.
- `once`: each follow-up got exactly one reply.
- One shot per form factor of the end state.

## Gotchas

- Wink hides Stop the moment it is clicked and marks the bot idle, whatever the engine does. Stop leaving the composer proves nothing; `freed` does.
- Type the follow-up while the held turn runs (Stop stays up), so only the send sits between the click and `freed`. Typing after the click put the send 2.4 s after it under load, too close to the 5 s grace for the red run to fail. `--timeout 2500`: `expect` connects about half a second after the send, so the window ends 3 s after sending.
- Check `freed` with `visible` and `:has-text()`: `text` on a bubble that is not there yet waits up to 1 s per poll and stretches the window.
- `[hold]` counts on the prompt's last line only: after a Stop, Wink's task record quotes the stopped message above the next prompt.
- `sleep 17` is the one fixed wait: no late reply can only be proven once the stub's 15 s hold has passed.
- Other engines, one desktop try each with this flow: claude (Atlas), codex (Juno) and antigravity (Vega) stopped within 2 s, a fresh CLI taking the follow-up 0.5-0.7 s after the click. grok (Orion) stopped only after its driver's 5 s grace (the stub drops `session/cancel`), so `freed` fails there. None posted a late reply.
- Use fresh text per run; the counts match the held and follow-up texts.

## Last proven

d4e97cfe (review-base), 2026-10-25: desktop and phone on Lyra (muse) PASS `running`, `freed`, `no-late-reply` and `once`; the follow-up was answered about 0.5 s after sending. With the stub's interrupt handling reverted, `freed` FAILs on both: the follow-up waits until 5.1 s after the click. Evidence `evidence/2026-10-25T20-58-51-d4e97cf`.
