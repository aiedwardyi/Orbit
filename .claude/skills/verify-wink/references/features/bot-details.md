# Bot details

## Sub-features

- The bot's avatar in the chat header opens Bot Details.
- Name, Title and Description (the job: how it should work) save as you type.
- Memory saves when the field loses focus and shows `Saving…`, then `Saved`.
- Every edit survives a reload, and the sidebar row and chat header follow the new name.

## How to get there

- Desktop: click the bot's avatar at the left of the chat header (`Open <name>'s profile`).
- Phone: tap the avatar or the bot's name in the chat header.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Vega/]'
$C click "role=button[name=\"Open Vega's profile\"] >> nth=0"
$C type 'role=textbox[name="Name"s]' "Vega Prime" --fill
$C type 'role=textbox[name="Title"s]' "Release captain" --fill
$C type 'role=textbox[name="Description"s]' "Cut releases and check the notes." --fill
$C type 'role=textbox[name="Memory"s]' "Ships on Fridays." --fill
$C click 'role=textbox[name="Name"s]'
$C expect saved visible '[role="status"]:has-text("Saved")'
$C reload
$C expect name visible 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Vega Prime/]'
$C click "role=button[name=\"Open Vega Prime's profile\"] >> nth=0"
$C expect title text 'role=textbox[name="Title"s]' "Release captain"
$C expect job text 'role=textbox[name="Description"s]' "Cut releases"
$C expect memory text 'role=textbox[name="Memory"s]' "Ships on Fridays."
$C shot bot-details-desktop
```

Phone: the same after opening the bot from the drawer.

## Proof

- `saved`: the memory card's status reads `Saved` after the blur.
- `name`: after a reload the sidebar row carries the new name.
- `title`, `job`, `memory`: the reopened details hold the edits, so they reached the server, not just the page. `expect text` reads an input's value.

## Gotchas

- `--fill` replaces the field; `type` without it appends to the old value.
- Name, Title and Description show no status; only Memory has `Saved`. Their proof is the reload.
- Memory saves on blur. Click another field (or press Tab) before expecting `Saved`.
- Two buttons carry `Open <name>'s profile` on each form factor (the avatar and the name); `nth=0` is the avatar.
- Pin field names with `"..."s`: a plain `name="Name"` also matches any label that merely contains "name".

## Last proven

Not yet. A follow-up card proves it.
