# Orbit polish board

Baseline: `feat/orbit-desktop` at `81890495d03c99bc765c14935be9cd6b3499fe1a`.

## Baseline and audit coverage

| Check | Evidence | Status |
| --- | --- | --- |
| Repository | Branch and commit verified from disk | PASS |
| Installer | `release/Orbit-1.0.0-setup.exe`, 122,330,800 bytes | PASS |
| Portable archive | 568 entries with `Orbit.exe` | PASS |
| Isolated launch | `.qa-data/atlas-baseline-01` and `.qa-user-data/atlas-baseline-01` | PASS |
| UI audit | `UI-AUDIT-EXT-01`, live CDP on packaged baseline | DONE |
| Orchestration audit | `ORCH-ARCH-EXT-01`, source and test review | DONE |
| Package audit | `PACKAGE-AUDIT-EXT-01`, packaged artifact inspection | DONE |

## P0

| ID | Finding | Owner | Evidence | Acceptance check | Status |
| --- | --- | --- | --- | --- | --- |
| PKG-1 | Updater feed targeted the source repository | Atlas | Isolated NSIS build writes `openmausbot-releases` to `app-update.yml` | Owned feed in packaged resources | CLOSED |

## P1

| ID | Finding | Owner | Evidence | Acceptance check | Status |
| --- | --- | --- | --- | --- | --- |
| UI-1 | Windows call control showed an urgency dot for an unsupported feature | Atlas | `CallView.tsx`; typecheck | Quiet control retains explanatory popover | READY FOR UI QA |
| UI-2 | Routines and webhook first-use copy exposed MAUS naming | Atlas | `RoutinesPage.tsx`, `WebhooksPanel.tsx`; typecheck | Bot language throughout affected surfaces | READY FOR UI QA |
| UI-3 | Three icon-only controls lacked accessible names | Atlas | `Sidebar.tsx`, `ChatView.tsx`, `OptionCard.tsx`; focused tests | Accessible names and hidden decorative glyphs | READY FOR UI QA |
| UI-4 | Model name disappeared at the supported 900x600 minimum | Atlas | `ModelPicker.tsx`; typecheck | Provider or engine name remains readable | READY FOR UI QA |
| ORCH-1 | Room and DM communication tools rejected valid member threads | Atlas | `server/index.test.ts`: room ask, delegate, wait, and nonmember denial | Room member communication succeeds and nonmembers receive 403 | CLOSED |
| ORCH-2 | Codex silently ignored a mid-task model switch | Atlas | 97 focused context, store, and Codex tests; POSIX integration test added | Unsupported session switch starts fresh with transcript replay | CLOSED |
| ORCH-3 | OpenAI-compatible and MiniMax drivers received duplicated transcript history | Atlas | 40 focused turn-context and driver tests | Each prior message appears once without a false fresh preamble | CLOSED |
| ORCH-4 | Routine catch-up skipped later due occurrences after downtime | Atlas | 22 routine tests, including a two-day outage | All stale occurrences settle and the newest in-window occurrence runs | CLOSED |
| ORCH-5 | Clipboard images vanished when support was unavailable or still loading | Atlas | `composer-attachments.test.ts`: supported, unsupported, unknown | Unsupported paste reports an error; loading state retains the image | READY FOR UI QA |
| PKG-2 | Browser surface leaked `orbit-desktop/1.0.0` in its user agent | Atlas | `browser-snapshot.test.mjs`: real packaged UA fixture, 7 tests | No Orbit, OpenMausBot, or Electron token remains | CLOSED |
| PKG-3 | Release workflows referenced pre-rename artifact and app paths | Atlas | YAML parse, script syntax checks, Windows package source path | Release jobs consume Orbit artifacts on all platforms | READY FOR INDEPENDENT REVIEW |

## P2

| ID | Finding | Owner | Evidence | Acceptance check | Status |
| --- | --- | --- | --- | --- | --- |
| UI-5 | First-use A-D chips look interactive but have no shortcuts | UI auditor | `OptionCard.tsx` | Wire keys or remove key styling | OPEN |
| UI-6 | Welcome onboarding lacks modal semantics and focus containment | UI auditor | `Onboarding.tsx` | Dialog role, modal state, and focus trap | OPEN |
| UI-7 | Command palette does not trap Tab or label search | UI auditor | `CommandPalette.tsx` | Tab containment and accessible search name | OPEN |
| UI-8 | Chat transcript has no heading | UI auditor | `ChatView.tsx` | One heading for the open conversation | OPEN |
| UI-9 | No durable shell-level offline indicator after connection | UI auditor | `App.tsx`, `store.tsx` | Reconnect state remains visible | OPEN |
| ORCH-6 | Codex full-auto advertises local computer access | Orchestration auditor | `server/drivers/codex.ts` | Full-auto refuses local computer scope | OPEN |
| ORCH-7 | Resume-cursor failure silently loses transcript context | Orchestration auditor | Codex and ACP fallback paths | Replay transcript or surface a notice | OPEN |
| ORCH-8 | User stop renders an error chip on Claude and Codex | Orchestration auditor | Driver interrupt paths | User stop settles without an error chip | OPEN |
| ORCH-9 | Queued-send chip can survive a server restart forever | Orchestration auditor | In-memory queue and client cancel path | Reconcile or clear the stale chip | OPEN |
| ORCH-10 | Reconnect hydration blocks live frames on slow peripheral requests | Orchestration auditor | `store.tsx` hydrate path | Chat frames flush when bots load | OPEN |
| ORCH-11 | Routine duration is promised but not enforced | Orchestration auditor | Routine request card and watchdog | Enforce duration or remove promise | OPEN |
| ORCH-12 | Stale queued routines can execute immediately after restart | Orchestration auditor | Routine recovery and dispatch | Runs past catch-up window become missed | OPEN |
| ORCH-13 | Queued routines dispatch newest first | Orchestration auditor | Reverse iteration in `routines.ts` | Execute in arrival order | OPEN |
| ORCH-14 | Some routine events emit before persistence | Orchestration auditor | Tick, disable, and webhook cancel paths | Persist before every state event | OPEN |
| ORCH-15 | Stall watchdog can strand an active routine | Orchestration auditor | Watchdog and active-run paths | Watchdog finalizes the run | OPEN |
| ORCH-16 | Room turns can bypass checkpoint restore leases | Orchestration auditor | Group turn dispatch path | Refuse dispatch while lease is held | OPEN |
| ORCH-17 | Paused or deleted routines keep running | Orchestration auditor | Routine pause and delete paths | Interrupt or visibly flag active run | OPEN |
| ORCH-18 | Hidden windows may not reconnect dropped SSE streams | Orchestration auditor | Visibility gates and Electron defaults | Reconnect while minimized | OPEN |
| ORCH-19 | Bot-written local markdown images render broken | Orchestration auditor | `ChatMarkdown.tsx`, SPA fallback | Render or degrade to a save link | OPEN |
| ORCH-20 | Save-file containment rejects task working folders and custom data roots | Orchestration auditor | Electron save path and task cwd | Allow the pinned cwd and configured data root | OPEN |
| ORCH-21 | Pathless engines receive unusable local attachment paths | Orchestration auditor | Attachment prompt and driver capabilities | Gate or upload files for pathless engines | OPEN |
| PKG-4 | Boot failure page uses the prior mascot | Package auditor | `electron/main.mjs` | Orbit mark on forced boot failure | OPEN |
| PKG-5 | Production asar includes desktop test files | Package auditor | Packaged asar inventory | Exclude test-only files | OPEN |
| PKG-6 | Windows deep-link scheme retains legacy identity and uninstall residue | Package auditor | Builder config and runtime registration | Orbit scheme installs and uninstalls cleanly | OPEN |
| PKG-7 | Webhook port conflict is invisible | Package auditor | Fixed webhook port and swallowed bind failure | Surface failure or choose a fallback | OPEN |
| PKG-8 | Existing OpenMausBot profiles have no migration guidance | Package auditor | Data and userData paths | Document fresh-start intent or migrate | OPEN |
| PKG-9 | Release defaults still call third-party account services | Package auditor | Electron service defaults | Confirm release ownership decision | OPEN |

## Verification log

| Check | Result |
| --- | --- |
| Typecheck after integrated fixes | PASS |
| Room communication integration test | 1 focused test passed, 113 filtered |
| Delegation tests | 28 passed |
| Transcript replay tests | 40 passed |
| Codex model-switch tests | 97 passed |
| Routine scheduler tests | 22 passed |
| Browser user-agent tests | 7 passed |
| Composer attachment tests | 16 passed |
| Contrast check | PASS with three carried baseline warnings |
| Full test suite | 2,293 passed, 98 skipped |
| Production build | PASS |
| Full lint | BLOCKED by repository baseline: 1,831 current errors versus 1,833 at baseline; no finding on integrated lines |
