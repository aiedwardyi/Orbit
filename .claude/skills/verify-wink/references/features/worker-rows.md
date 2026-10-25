# Worker rows in chat

## Sub-features

- A worker a bot launches in a terminal pane shows as one row in that bot's chat: nickname, model, state.
- Its reports fold into the same row; the state moves Working, Waiting, Failed, Done, or Ended when the pane is gone.
- The header strip counts workers by state and opens the list (`<n> working, ... Show workers`).

## How to get there

- Desktop and phone: open a bot that has launched workers. The rows sit in the transcript at the launch; the strip sits in the chat header.

## Driving it

Gap: launches and reports come from Electron's terminal bridge (terminal panes, `terminal_spawn`), which the web kit does not run. No user path in the web UI creates a worker.

Closest real path, for the follow-up card: a loopback stand-in for the bridge, so the server writes the real messages through its own route.

1. Serve `GET /v1/bots/<botId>/terminal?sessionId=<id>` on `127.0.0.1` and answer `{ "sessionId": "<id>", "label": "Nova (gpt-5.5)", "cwd": "C:\\work", "panes": [{ "sessionId": "<id>", "main": false }] }`. Accept any bearer; the server signs a per-bot grant from the token.
2. `PUT /api/internal/terminal-bridge` with `{ "url": "http://127.0.0.1:<port>", "token": "<any>" }` (bearer: the kit's comms token).
3. `POST /api/internal/launch-note` with `{ "fromBotId": "<botId>", "sessionId": "<id>" }`. The server appends a `kind: "launch"` message: `Launched <label>`, `Label:`, `Working folder:`, `Session:`.

Then drive and prove in the UI:

```bash
C="node .claude/skills/verify-wink/control-wink.mjs"
$C open desktop
$C click 'aside[aria-label="Bots and navigation"] >> role=button[name=/^Juno/]'
$C expect row visible '[data-worker-run]'
$C expect state count '[data-worker-run] [data-worker-state="working"]' '>=1'
$C expect strip visible 'role=button[name=/1 working/]'
$C shot worker-rows-desktop
```

## Proof

- `row`: the launch renders as a worker row, not a raw text bubble.
- `state` and `strip`: the row and the header count agree on the state.
- Phone: the same row in the transcript; the strip folds to a compact mark below 768 wide.

## Gotchas

- Rows are keyed by bot, the first 8 characters of the session id, and the nickname; reuse a session id and the row merges.
- Without a live pane list from Electron, `shownState` keeps the stored state; `Ended` needs the bridge's live panes.
- A report row needs a `kind: "note"` pane message, which also comes through the bridge. Prove launch rows first.

## Last proven

Not yet. Gap in the web kit; the closest path above is for the follow-up card.
