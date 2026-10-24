# How Wink works

## Engines and keys

- Bots and workers run on the user's own CLI sign-ins: Claude (Claude Code), Codex, Grok, Antigravity (Gemini, through the `agy` CLI) and Meta Muse. A signed-in engine needs no API key.
- The user picks each bot's engine, model and effort in the model picker (Alt+M, Open Model Picker). Switching keeps the chat: the new engine gets the conversation so far.
- Saved keys are only for calling an API directly:
  - xAI, Gemini, Claude and Vertex AI keys: `call_api` to that provider's own API.
  - OpenAI key: `generate_image`.
  - ElevenLabs key: text-to-speech through `call_api`.
  - A custom key: `call_api` to the one host it was saved for.
- Ask for a key only when the job needs that exact API and no signed-in engine can do it. "Ask Grok to search X" needs a Grok worker pane or teammate bot, not an xAI key.
- Saved keys show under Settings > Connections > Keys. They stay encrypted on that PC and do not sync.
- If a worker pane shows a login prompt, tell the user that engine needs signing in. Do not ask for a key instead.

## Workers and teammates

- Worker panes: a bot with the terminal starts engine CLIs in panes and hands them jobs. The harness playbook covers how.
- Teammate bots: other bots in the same Wink. `list_bots` finds them, `ask_bot` waits up to 4 minutes for a reply, and `delegate_bot` hands work off without waiting.
- Sections group bots in the sidebar (Move to section in a bot's menu). A section can have one Chief of Staff (Make Chief of Staff in the same menu), who coordinates that section and can create specialist bots.
- Groups are shared chats with several bots and the user (New group in the sidebar's + menu).

## Where things live

- Wink's data folder is `~/.orbit`.
- Each bot's workspace is `~/.orbit/workspaces/<bot id>`. It holds `MEMORY.md` and `memory/<topic>.md`.
- Chat attachments are in `~/.orbit/attachments`.
- Project Folder is the folder the user picks in a bot's profile. `generate_image` saves to `generated-images` and `call_api` files to `api-files`, in the task's folder, else the Project Folder, else the workspace.

## Sync and phone

- Sync is under Settings > Account. Google Sign-in syncs through a folder in the user's own Google Drive. Drive Folder syncs through a folder the user picks instead.
- What syncs across the user's PCs: bot profiles and settings, sections and their order, chats, memory files and chat pictures. Keys and engine sign-ins stay on each PC.
- If a chat changed on two PCs at once, Wink keeps both and the chat says "This chat also changed on another PC. Both versions were kept." A memory file edited on two PCs keeps the other copy beside it as `memory/<name>.conflict-<hash>.md`.
- The phone opens Wink in its browser and reaches a PC running Wink, with that PC's chats. Set it up under Settings > Account: Phone Access (a relay; Add a Phone shows a pairing code) or Phone Link (over Tailscale). With sync on, the phone can switch between the user's PCs.

## Keyboard shortcuts

All are listed under Settings > Shortcuts. On a Mac, Alt is Option and Ctrl is Cmd.

- Alt+T: Toggle Themes. Alt+Shift+T: Cycle Theme.
- Alt+U: Toggle Usage. Alt+R: Refresh Usage.
- Alt+I: Toggle Model Index. Alt+Shift+I: Cycle Model Index Tab.
- Alt+M: Open Model Picker.
- Alt+W: Toggle Workers.
- Ctrl+`: Toggle Terminal.
- Ctrl+Enter: Queue Message (sends after the running turn).
