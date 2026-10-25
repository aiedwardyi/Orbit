# Model picker

## Sub-features

- Alt+M opens the picker over the chat (`Choose model`); Alt+M or Escape closes it unchanged.
- A click picks a cell; Enter, or a second click on the picked cell, saves and closes.
- The chat header chip shows the saved model, and the next turn runs on it.

## How to get there

- Desktop: Alt+M anywhere in a chat, or click the model chip in the chat header.
- Phone: tap the model chip in the chat header (no keyboard shortcut).

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Atlas/]'
$C press Alt+KeyM
$C expect opened visible 'role=dialog[name="Choose model"]'
$C eval '[...document.querySelectorAll("[data-model-cell]")].map((cell) => cell.dataset.modelCell + (cell.ariaPressed === "true" ? "*" : ""))'
$C click '[data-model-cell="MODEL"]'
$C expect picked count '[data-model-cell="MODEL"][aria-pressed="true"]' 1
$C press Enter
$C expect closed count '[data-model-picker-content]' 0
$C expect chip text '[data-model-label]' "NAME"
$C reload
$C expect kept text '[data-model-label]' "NAME"
$C shot model-picker-desktop
```

`MODEL` is a cell id from the `eval` (the current one ends in `*`); `NAME` is the label the chip shows for it. Phone: replace `press Alt+KeyM` with `click 'button:has([data-model-label])'`.

## Proof

- `opened`, `picked`, `closed`: the dialog opened, the cell took the pick, the dialog went away.
- `chip` and `kept`: the header shows the new model, before and after a reload.
- A send afterwards replies `STUB CLAUDE <model> | ...`, so the turn used the new model id.
- Escape after a pick leaves the chip on the old model.

## Gotchas

- The shortcut matches `event.code === "KeyM"`; send `Alt+KeyM`, not `Alt+m`.
- Alt+M is ignored while another trapping dialog is open (the Team Library); close it first.
- The closing dialog lingers a frame with `data-closing`; check `[data-model-picker-content]` count, which drops at once.
- The chip shows a shorter name below 768 wide; read `NAME` per form factor.

## Last proven

Not yet. A follow-up card proves it.
