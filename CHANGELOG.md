# Changelog

All notable changes to Wink, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are on [GitHub Releases](https://github.com/aiedwardyi/orbit-releases/releases).

## [1.0.205] - 2026-10-25

### Changed
- After your PC starts or wakes, chats sync before pictures.

### Fixed
- A message sent while your PC was still catching up joins the chat instead of being hidden, and the bot is told what it missed.

## [1.0.204] - 2026-10-24

### Added
- The timeline marks messages that carry an image or a file.

## [1.0.203] - 2026-10-24

### Added
- When an engine hasn't replied for 2 minutes, the waiting line names it and counts the minutes.
- Changing a Claude bot's effort mid-turn applies at its next step, in the same session.
- When a bot's project folder is missing, Choose folder picks a new one in place of Retry.

### Changed
- The chat header drops its busy spinner, and step spinners hide while Wink is out of focus.

### Removed
- Untested engine drivers. Wink runs Claude Code, Codex, Gemini, Grok and Muse.

### Fixed
- Chats synced from your other PCs show new messages within seconds instead of up to 30 s.
- New Claude Code workers no longer get stuck on the folder trust prompt.

## [1.0.202] - 2026-10-24

### Added
- Alt+W opens and closes the worker list.

### Fixed
- A Claude worker's save line now submits near its context limit, with no false context note.

## [1.0.201] - 2026-10-23

### Fixed
- Pinning or unpinning a message on one PC now shows on your other PCs.

## [1.0.200] - 2026-10-23

### Changed
- Worker cards ask for the smallest diff in the repo's own voice, with new logic kept out of large files.

### Fixed
- Opening Wink on your phone renews its remote login, so uploads no longer fail as unauthorized after 30 days.
- A Windows update cut off by a restart finishes at the next sign-in instead of leaving Wink uninstalled.
- No false context note while a Claude worker compacts or its save line waits in the input.

## [1.0.199] - 2026-10-23

### Changed
- The terminal header no longer has a Restart button; restart from the footer when the shell exits, or from the project-changed banner.

### Fixed
- Wrapped keyboard shortcut keys stay right-aligned on narrow screens.
- A bot channel only gets the reply meant for that bot, not a status update for you.
- Gemini Argon and Flash workers show the Gemini icon.
- Deleting a bot removes the event logs of all its tasks.
- Moving a pinned bot down lands it one row down, not two.
- On phone, the first quick tap on a thread's turn rail opens it.
- Adding a bot while creating a group keeps the current chat in view.
- Escape closes step 2 of the group wizard without a click first.
- The webhook "..." menu closes after Edit settings, and editing a webhook whose bot was deleted picks a live bot.

## [1.0.198] - 2026-10-22

### Added
- The working indicator shows elapsed time for the whole turn, like "(1m 19s)".

### Changed
- One Stop ends the turn and puts any queued messages back in the message box, on every device.
- While Wink isn't focused, the working ring hides and the timer keeps ticking, which saves CPU.
- Bots save a lesson from each correction without being asked.

### Fixed
- "Continue" after a stopped turn picks up the request that never finished, not an older task.
- A busy Gemini turn retries even after it already wrote a progress note.
- Tooltips on the bot list header no longer hide under the Windows title bar.

## [1.0.197] - 2026-10-21

### Changed
- Settings > Connections shows one Sign In or Sign Out per engine, with no path settings.

### Fixed
- Muse tool steps show in chat while a turn runs, when Show tool calls is on.
- Grok sessions restart only when they're actually large, not after a fixed number of tool steps, so long Grok chats stop repeating themselves.

## [1.0.196] - 2026-10-21

### Added
- One-click sign-in for Claude, Codex, Grok and Muse in Settings > Connections. Gemini opens a terminal and detects sign-in.
- Hovering an engine in Settings shows the account it's signed in with.
- Use Google Photo in Account settings switches back to your Google picture.

### Changed
- Bots split several tasks at once into parallel visible workers.
- A worker's notes go to the bot that started it.

### Fixed
- Workers no longer stop at Claude, Codex or Grok folder trust questions.
- Worker icons show for model names written without a space, like "Opus5.5".
- Phone Link shows the link to turn on Tailscale Serve and connects once it's on, with no restart.
- Gemini retries by itself when its servers are busy, and long Gemini turns run up to 60 minutes.

## [1.0.195] - 2026-10-21

### Added
- The model picker shows the list price per 1M input and output tokens for current models.
- Change Photo and Remove Photo in Edit Profile. A new install fills your name and photo from Google sign-in, and a removed photo stays removed.
- Agentic Mode can wait for a set start time before it runs the next step.

### Changed
- Keep going is now Agentic Mode. Turning it on approves the whole task, including steps a bot adds or rewords later.
- Labels use Title Case.
- Rules your Chief of Staff bot passes on count as your own for other bots.
- Bots react to messages a little more often.
- Workers run at high effort by default, and at max only in max mode.

### Fixed
- A worker pane that exits early now tells its bot, and a pane whose shell fails to load on Windows retries once.
- Fewer repeated context notes, and no early stall notes for workers still waiting to start.
- Worker effort shows for labels with a trailing note, like "high API".

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

[1.0.205]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.205
[1.0.204]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.204
[1.0.203]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.203
[1.0.202]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.202
[1.0.201]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.201
[1.0.200]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.200
[1.0.199]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.199
[1.0.198]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.198
[1.0.197]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.197
[1.0.196]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.196
[1.0.195]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.195
[1.0.194]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.194
[1.0.193]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.193
[1.0.192]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.192
[1.0.191]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.191
[1.0.190]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.190
[1.0.189]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.189
