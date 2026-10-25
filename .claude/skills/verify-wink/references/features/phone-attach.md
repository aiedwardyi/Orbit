# Attach and send an image from the phone

## Sub-features

- The paperclip (`Attach a file`) opens the phone's file picker; images land in a tray above the composer.
- The tray shows a preview and a remove button per image; text can go with it.
- Send uploads the image, the user bubble shows it, and the engine receives it.

## How to get there

- Phone: open a bot from the drawer and tap the paperclip at the left of the composer.
- Desktop: the same button, or paste or drop an image into the composer.

## Driving it

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open phone
$C click 'role=button[name="Open bot list"]'
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Atlas/]'
$C shot attach-source-phone                       # prints its path; any small PNG works
$C attach <path to a png>
$C expect tray visible 'role=button[name=/^Preview /]'
$C type 'textarea[data-orbit-composer]' "what is in this image"
$C click 'role=button[name="Send message"]'
$C expect bubble visible '[data-orbit-message="user"] >> nth=-1 >> role=button[name=/Preview attached image/]'
$C wait-settle --text "re: what is in this image"
$C expect engine text '[data-orbit-message="bot"] >> nth=-1' "| 1 image"
$C shot phone-attach-phone
```

## Proof

- `tray`: the picked file shows as a preview in the composer tray.
- `bubble`: the sent message carries the image (`Preview attached image <name>`), not `Image not available`.
- `engine`: the stub counts one image in the prompt Wink sent, so the upload crossed the server into the engine.

## Gotchas

- `attach` clicks the button and answers Playwright's file chooser; no OS dialog opens. Use `--button` for another trigger.
- The tray takes images only when the bot's engine supports them. Atlas (claude) does.
- Expect the tray preview before Send, so the send carries the image.
- Camera capture and the photo library are the phone's own UI; the file chooser stands in for both.

## Last proven

Not yet. A follow-up card proves it.
