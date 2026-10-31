# Changelog

All notable changes to Wink, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are on [GitHub Releases](https://github.com/aiedwardyi/orbit-releases/releases).

## [1.0.218] - 2026-10-31

### Fixed
- An idle worker gets nudged again at 30 and 60 minutes instead of only once.
- A bot that gets asked a question in a delegated reply is woken to answer it.
- Workers delete their own scratch folders when they finish.
- "Worker finished" notes come only from commands a bot started.

## [1.0.217] - 2026-10-31

### Added
- Unread chats show a count on the bot's avatar. Mark as Unread shows 1.

## [1.0.216] - 2026-10-30

### Added
- Swipe down to close sheets on the phone.
- The bot's subtitle shows "3 workers" while its workers run, and the model again when they finish.
- Settings > Phone pairs a phone with a QR code.
- One-button engine setup that notices when the install finishes.
- Phone Settings is a labeled list.

### Changed
- Wink opens in Korean on Korean Windows unless you picked a language.
- Agentic mode keeps working until an engine is fully out of its limit.
- "Engine" is used everywhere for Claude, Codex, Grok, Gemini and Muse.
- First run is simpler: clearer New Bot path, a suggested bot name, and Usage lists only installed engines.

## [1.0.215] - 2026-10-30

### Fixed
- Settings > Usage shows each Codex limit once.
- Claude and Grok limits refresh again in Settings > Usage.
- The usage refresh error reads as two sentences, in Korean on a Korean screen.
- Long chats keep the names, codes and numbers you gave the bot after a summary.
- The remove X on an attached file shows in full.

## [1.0.214] - 2026-10-29

### Added
- A chat that hits a Claude or Codex usage limit resumes on its own when the limit resets; sending any message cancels it.
- 13 more avatar choices: 8 job symbols and 5 engine colors.
- Optional error reports, off until you turn them on.

### Changed
- A usage limit shows "Usage limit reached" with its reset time.
- Each bot shows the avatar color you picked everywhere, and a calm gray icon is one of the choices.
- Confirmations like delete open inside Wink instead of a Windows dialog.
- Wink shows no Windows pop-ups while it is the window in front.

### Fixed
- Keys saved from your phone or another PC are stored on the bot's own PC.
- Codex "model at capacity" stalls continue on their own and never type over a message you are writing.
- While Codex thinks silently, the chat shows Thinking instead of the no-reply hint.

## [1.0.213] - 2026-10-28

### Changed
- Bot lists show Wink icons in a calm style; the open chat's header keeps the icon in full color. Uploaded photos and older icons look the same.
- The avatar picker offers only the Wink icons, plus your own image.
- Default-font themes use Geist for English text; Korean text keeps its current fonts.

## [1.0.212] - 2026-10-27

### Added
- Install in Settings > Connections and onboarding runs the engine's install in a terminal with one tap, and installs Node first when the engine needs it.

### Changed
- GPT-6.1 Terra replaces GPT-5.6 Terra in the Codex picker, and saved picks move over.
- Bots know their plain text shows in chat, so fewer notes to self reach the chat.

### Fixed
- The no-reply hint waits for real engine silence: while Claude thinks, the chat shows Thinking instead of the hint.
- On phones, Back closes Select text, and holding a word shows the phone's own drag handles.
- Back closes pop-ups in the order they opened.

## [1.0.211] - 2026-10-27

### Changed
- Terminal skins leave a blank row before a reply that follows tool rows, so replies are easier to spot.

### Fixed
- Phone Back closes the worker list, and other open pop-ups, before it leaves the chat.
- Opening an offline PC from the device list shows the unreachable page instead of hanging, and PCs no longer stay Offline when Tailscale starts after Wink.
- Phones no longer get a 502 error on a connection that sat idle for 90 seconds.
- Install in Settings > Connections opens the install terminal with the engine's command, as onboarding does, instead of the engine's website.
- Pasting right after a screenshot attaches the image instead of an empty file, and a paste that still fails says so.
- File links to Windows paths with a backslash before a dot or other punctuation, like `\.orbit`, open on desktop and phone.
- Switching models from the no-reply hint no longer reruns the last message while a follow-up is still posting.
- While Codex reconnects, a worker note or a new message no longer drops the chat out of Reconnecting.
- While a worker waits on a limit or stall, phones stop downloading its whole terminal screen every 15 seconds.
- The Thinking shimmer hides while Wink is unfocused or hidden, instead of freezing mid-word.
- On the usage page, an engine's name opens the same account card as its icon.

## [1.0.210] - 2026-10-26

### Fixed
- Workers start again on PCs with little free memory, like 8 GB laptops: the 2 GB reserve from 1.0.209 is gone, so a terminal opens whenever free memory covers its engine, as in 1.0.208.

## [1.0.209] - 2026-10-26

### Added
- Worker launches show the engine's 5-hour and weekly usage left, and a launch on a nearly empty window is held once.
- Bots see the names of your saved API keys, never the keys, so they use them instead of asking for a new one.

### Changed
- The fixed 32-terminal limit is gone: bot terminals open while the PC keeps 2 GB free, and a refusal names the bots holding terminals.
- After Wink refreshes a bot's session, the bot skips rereading big files unless the task needs them.

### Fixed
- A worker row goes back to Working once its terminal moves again, and waits on a background agent or a usage-limit pause no longer send stall notes.
- A worker's row sits at its newest message on every device, and loading older messages never moves it.
- On phones, the scrollbar no longer covers worker status words.
- A silent tool no longer holds a bot's chat for 30 minutes; bots give up after 5.
- A dropped Codex connection shows a quiet "Reconnecting" line instead of a red error per retry.

## [1.0.208] - 2026-10-26

### Added
- A message sent to a chat that is still syncing from another PC waits for it, up to 10 seconds ("Sends after sync"), so the bot replies with the whole chat in view.

### Changed
- After a restart, the chat you had open syncs first.

### Fixed
- A chat that split between two PCs shows its notice.

## [1.0.207] - 2026-10-25

### Added
- When a model hasn't replied for 2 minutes, Switch on its hint reruns your last message on the model you pick.

## [1.0.206] - 2026-10-25

### Added
- Bots can open a short guide to Wink when a task is about Wink itself.

### Changed
- Bots use an engine you're signed in to before asking for an API key.

### Fixed
- A bot no longer stays busy after two failed starts in a row, such as a moved project folder or a missing CLI.
- A group keeps answering after a failed start.

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

[1.0.217]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.217
[1.0.216]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.216
[1.0.215]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.215
[1.0.214]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.214
[1.0.213]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.213
[1.0.212]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.212
[1.0.211]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.211
[1.0.210]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.210
[1.0.209]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.209
[1.0.208]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.208
[1.0.207]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.207
[1.0.206]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.206
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
