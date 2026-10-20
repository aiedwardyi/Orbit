# Changelog

All notable changes to Wink, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are on [GitHub Releases](https://github.com/aiedwardyi/orbit-releases/releases).

## [1.0.194] - 2026-10-20

### Added
- Keep going: a per-bot switch that starts the next approved plan step every 30 minutes while the bot is idle. A small mark on the avatar and chat header shows when it is on, and telling a bot "keep going" turns it on.
- A bot gets a short note to move details into side files when its memory nears the size limit.

### Changed
- Workers get their context note at about 80% of the window, and Wink types the save-progress line into the worker itself.
- Messages from other bots show on the left under a "Message from" label.
- Shorter text in bot settings.

### Fixed
- Claude Code menus in worker panes redrawing in the wrong place.
- Worker panes dropping the user's own status line on some PCs.

## [1.0.193] - 2026-10-20

### Added
- Chat box ring: a Theme colors choice next to Rainbow that shimmers in the current theme's own colors.
- Model index: Design and Security tabs, and Coding now ranks on Terminal-Bench and FrontierCode with the newest models.
- A dev update channel for testing new builds on one PC, with a one-click way back to stable from the taskbar menu.

### Changed
- Auto mode now covers routines and other turns nobody started, so they never stall on a permission card. Desktop control in those turns is skipped instead of asked.
- Settings > Shortcuts shows one row: Queue message, Ctrl+Enter or hold Send on a phone.

## [1.0.192] - 2026-10-20

### Added
- Model index: Gemini 4 Argon on the Intelligence, Agentic and General charts.
- A bot gets one note when a worker it launched passes 200k context, and its pane list shows each worker's context size.

### Changed
- The chat box is ready about 0.3 s sooner after launch.
- Worker panes run at below-normal CPU priority, so Wink stays quick while workers are busy.
- Spinners and the rainbow chat box pause while Wink is in the background. The needs-you pulse keeps running.
- A new pane needs only the memory its engine uses (600 MB for Claude, 150 MB for Codex or Muse), not 2 GB free.
- Claude workers summarize at about 300k context instead of 500k.

### Fixed
- The Legal chart in the model index not drawing.

## [1.0.191] - 2026-10-19

### Changed
- Most replies no longer wait for a chat summary to finish. The summary lands on the next turn.
- Bots skip the closing recap after tool work.

### Fixed
- Send now showing while a turn was still getting ready, when it could not act.
- Gemini replies showing a timeout error that was already retried.

## [1.0.190] - 2026-10-18

### Added
- Right-click a queued message to send it now or cancel it. On a phone, hold it. Groups offer Cancel.
- Right-click a chat image, or the full-size view, to copy or save it.
- Wink-style tooltips replace the old Windows ones across the app.
- Settings > Shortcuts lists the chat keys: Enter, Ctrl+Enter and hold Send.

### Changed
- Settings > General is down to Language, Bot list side, Reply style and Updates. The rest is under Advanced.
- Desktop pop-ups pause while the PC is idle for 5 minutes or locked. Phone alerts are unchanged.
- Reactions are down to 14, with 😮 in the right-click row.
- A bot's row lights up only when it posts something you can see.
- Empty Quorum days show a thin baseline.

### Fixed
- The phone header hiding the model name.
- Worker names cut short in the workers menu.
- The Quorum row loading late and jumping on hover.
- A waiting marker stuck in a reply's buttons.
- Right-clicking a file link opening two menus.
- False "stuck" alerts on quiet workers, and repeated usage-limit notes.
- Tooltips on long pasted text running off the screen.

## [1.0.189] - 2026-10-18

### Added
- Right-click a file link to show it in its folder, save a copy or copy its path.
- Worker rows show effort next to the model, like `Muse 1.3 · Max`.

### Changed
- In long chats, the timeline rail is the scrollbar.
- The timeline card opens when the mouse rests on the rail, not in passing.
- Several memory saves in a row fold into one "Memory updated · N notes" row.
- A follow-up sent while a Claude reply is still thinking joins it, so you get one answer.
- Replies to worker notes no longer send a finished alert.
- 👌 replaces 🫡 in reactions, since Windows 10 draws 🫡 as a box.

### Fixed
- A reply's last characters showing up later as a stray bubble.
- Gemini replies repeating a rate-limit error that was already retried.
- Blank Gemini and Qwen icons in narrow windows and on phones.
- Long-chat summaries failing instead of trimming to fit.
- A teammate's answer lost when your message joined its turn.
- A teammate's "Reply to @X" label dropped when another message landed first.
- A stalled Claude restart delivering its reply on the next turn.
- Over-limit task records rejected, or clipped inside a file path.
- Timeline, swipe and question card polish.

[1.0.194]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.194
[1.0.193]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.193
[1.0.192]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.192
[1.0.191]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.191
[1.0.190]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.190
[1.0.189]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.189
