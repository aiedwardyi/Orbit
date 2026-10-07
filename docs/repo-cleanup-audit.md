# Orbit repo cleanup audit

**Status:** Step 0, read-only audit. Nothing in this report has been acted on, and no product code or history was changed.
**Audited:** `review-base` @ `f825bdfa` (2026-10-07). CI data came from the GitHub REST API on the same day.
**Scope:** CI, oversized files, repo hygiene, dead-code candidates, and a ranked cleanup plan.

The history has 1,921 commits. About 611 of them are by the upstream OpenMausBot author (Milind Soni, under two identities), and 256 are merge commits. Every step below keeps this history: none of them rebases, squashes old history, or rewrites authorship.

---

## TL;DR: top findings

1. **Trunk CI has been red since 2026-10-02, and red PRs are being merged.** The last green `ci.yml` run on `review-base` was `37e10667` ("chore: release 1.0.107", 2026-10-02). Over the last 100 trunk runs the results were 21 success, 55 failure and 24 cancelled. PRs #303–#310 all merged with failing PR checks. `review-base` has no branch protection and no rulesets (`protected: false`, `rulesets: []`). Open PR #311 (`fix/ci-green`, mergeable, PR run green) fixes the 23 stale tests.
2. **The full Windows suite takes about 15 minutes, and almost all of it is one serial vitest run.** `pnpm test` takes 12m47s of a 14m52s job, of which vitest is 746.9s. `fileParallelism: false` (`vite.config.ts:26`) runs 424 files one at a time. Vitest's built-in `--shard` across 3–4 runners would bring the job down to about 5–6 minutes. The test floor is stale: it is 1,070 against 5,936 tests that actually register (`scripts/test-floor.mjs:30`).
3. **The contributor docs disagree with the repo.** `CONTRIBUTING.md` is titled "Contributing to OpenMausBot", clones `milind-soni/OpenMausBot`, and calls macOS the primary platform. The GitHub description reads "Private Orbit desktop release checkpoint" on a public repo. `pnpm lint` is documented but not in CI. There is no CODEOWNERS file. Root `HANDOVER.md` and `REPORT.md` are internal session notes, and they contain a local Windows user path.

---

## 1. CI

### 1.1 Current reliability

Commands: `gh api "repos/aiedwardyi/Orbit/actions/workflows/ci.yml/runs?branch=review-base&per_page=100"` and `gh run list --workflow ci.yml -L 30`.

| Window | success | failure | cancelled |
|---|---|---|---|
| Last 100 `ci.yml` runs on `review-base` | 21 | 55 | 24 |

- **The last green trunk run** was `37e10667`, 2026-10-02T04:48Z. Every trunk push since then has failed or been cancelled.
- **The latest trunk run is red.** Run `37571359121` (#310, `f825bdfa`) failed in the `pnpm test` step. Two files fail:
  - `server/index.test.ts`: 14 failed (project-folder prompt tests, task continuity, engine default effort)
  - `server/context-compaction.e2e.test.ts`: 9 failed

  These are deterministic failures from stale tests, not flakes. PR #311's title is "test: update 23 tests left stale since 10-02", and 14 + 9 = 23.
- **Red PRs were merged.** PR runs on `fix/qa-menus` (#307), `fix/grok-usage` (#308), `fix/delete-sync` (#306), `fix/engine-signin` (#305), `feat/doc-upload` (#303), `feat/terminal-fast-open` (#304), `fix/visual-polish` (#309) and `fix/narration-notice` (#310) all ended `failure`. Each PR was merged anyway. Nothing enforces a green check.
- **Many runs are cancelled.** On PRs, `cancel-in-progress` (ci.yml:13) cancels superseded runs. On trunk, pushes queued close together cancel the pending run: #304–#306 and #308 each ended `cancelled` after about 10s on 2026-10-06 14:30. This is expected behaviour, but it means a batch of merges gets tested only at its tip.
- **Fix in flight.** PR #311 (`fix/ci-green`) is open and `mergeable_state: clean`, and its run `37632492307` is green (Windows 14m52s, control-plane 44s).

### 1.2 How long the full Windows suite takes

Source: `gh api repos/aiedwardyi/Orbit/actions/runs/37632492307/jobs`, the latest green run. Job `typecheck + test (Windows)`:

| Step | Duration |
|---|---|
| setup (checkout, pnpm, node) | ~0:54 |
| `pnpm install --frozen-lockfile` | 0:07 |
| `pnpm typecheck` | 0:18 |
| `pnpm build` | 0:24 |
| **`pnpm test`** | **12:47** |
| `pnpm check:electron` | 0:14 |
| **Job total** | **14:52** |

- **Inside `pnpm test`,** the vitest log reads "Test Files 423 passed | 11 skipped (434)", "Tests 5827 passed | 109 skipped (5936)", "Duration 746.87s (… tests 628.84s …)". The `node --test` suites, broker tests and packaged-server smoke that follow take about 20s in total.
- **Across the last 81 completed runs (success or failure, all branches),** wall time is min 637s, median 903s (about 15 min) and max 1,884s (31m24s, run `37479589050`). The job timeout is 35 min (ci.yml:21), so the slowest run used about 90% of it.

**Slowest test files** (green run, serial):

| ms | file |
|---|---|
| 92,193 | server/index.test.ts |
| 53,909 | server/context-compaction.e2e.test.ts |
| 51,595 | server/thread-sync-v2-store.test.ts |
| 45,667 | server/drivers/acp/acp.test.ts |
| 37,328 | server/mailbox.test.ts |
| 33,755 | server/thread-sync-v2.test.ts |
| 29,471 | server/comms.test.ts |
| 27,445 | server/memory-sync.test.ts |
| 21,351 | server/drivers/claude.test.ts |
| 16,152 | server/steer-queue.test.ts |

The top 10 account for 409s, about 65% of the 629s of test time. The other 414 files share the remaining ~220s.

### 1.3 Would a test split help? Yes.

- **Vitest runs strictly serially.** `fileParallelism: false` is set in `vite.config.ts:26`, with the comment "the suite spawns fake provider CLIs and a real harness server; parallel files introduce load-sensitive flakes". In-process parallelism is therefore off the table, but parallelism across machines is not.
- **Recommended: a 3–4-way `vitest run --shard=i/N` matrix on `windows-latest`.**
  - Each shard repeats about 2 minutes of setup, install, typecheck and build. Build could be kept to one shard.
  - At 3 shards the job would take about 2 + 250/1 s ≈ **6 minutes per shard** in wall time, against 15 minutes today. The largest single file (92s) sets the floor.
  - Vitest assigns shards by file, so the test files themselves do not change.
- **Required companion changes, to go in the same PR:**
  - `scripts/test-floor.mjs` treats `--shard` as a "targeted run" (`TARGET_FLAGS`, L32), so the floor would silently stop applying. The fix is either a final job that sums `numTotalTests` across shard JSON summaries, or a per-shard floor.
  - The floor (`TEST_COUNT_FLOOR = 1070`, L30, "most recently verified full run (1091 registered tests, 2026-08)") should rise to about 5,800. Today about 82% of the suite could vanish without tripping it.
  - The comments in `test-floor.mjs:59,114` mention a "3-OS CI matrix". CI is Windows-only (ci.yml:17–20), so the comment is stale.
- **Optional, later:** split `server/index.test.ts`. It is 5,773 lines, 14 describes and 154 tests sharing one server booted at L102–309. Splitting it by area evens out the shards (see §2).
- **Cheap extra:** run `pnpm lint` (oxlint) as its own job. It is documented as a quality gate in README "Quality gates" and is not in any workflow (`grep -rn lint .github/workflows` finds nothing). Lint's current state is unknown: dependencies were not installed for this audit.

### 1.4 Branch-protection gaps

| Check | Result | Evidence |
|---|---|---|
| `review-base` protected | **No** | `gh api repos/aiedwardyi/Orbit/branches/review-base` → `{"protected":false}` |
| Repository rulesets | **None** | `gh api repos/aiedwardyi/Orbit/rulesets` → `[]` |
| Required status checks | **None**, so red PRs merge (§1.1) | — |
| Classic protection details | Not readable by this integration (403) | `…/branches/review-base/protection` → 403 |
| `ci.yml` push trigger includes `main` | `main` branch does not exist | ci.yml:5; the branch list has no `main` |

**Recommendation:** add a ruleset on `review-base` that:
- requires PRs,
- requires the `typecheck + test (Windows)` check (or the shard checks) and the `control-plane …` check,
- blocks force-pushes and deletion,
- requires a linear history only if you also switch to squash-only (§3.1).

Leave admin bypass on so release hotfixes are still possible.

### 1.5 Other CI notes

- **Inconsistent checkout pins.** `claude-review.yml` pins `actions/checkout@11d5960a…  # v4`, while every other workflow uses v7.0.1 (`3d3c42e5…`).
- **Runner migration.** The control-plane job got this annotation: "ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026." Consider pinning `ubuntu-24.04`, as `release.yml` already does.
- **Manual-only workflows.** `package-win.yml`, `package-linux.yml` and `release.yml` run only on `workflow_dispatch`. That is fine.

---

## 2. Oversized files

Command: `git ls-files | grep -E '\.(ts|tsx|js|mjs|cjs)$' | xargs wc -l | sort -rn`.

### 2.1 Top 15 product source files

These counts exclude tests, `electron/vendor/` and `third_party/`.

| # | Lines | File | Natural seam? |
|---|---|---|---|
| 1 | 10,211 | `server/index.ts` | **Yes, major.** See §2.3. |
| 2 | 3,333 | `src/state/store.tsx` | **Yes.** It has 4 layers: types and selectors (L70–643), the `reducer` (L1018–1893, about 875 lines), the API client (L1976–2037), and `StoreProvider` (L2055–3318), which holds the side-effect switch (L2181–2775) and the SSE fold (L2776–~3220). Moving the types and reducer out is mechanical. |
| 3 | 2,642 | `src/components/Sidebar.tsx` | **Yes.** 8 inline subcomponents (`BotListItem` L790–1082, `ArchivedBotsPanel` L1083–1220, the context menus, and others) can move to `components/sidebar/`. |
| 4 | 2,402 | `electron/main.mjs` | **Yes.** It has 72 `ipcMain.handle/on` registrations (mostly L1781–2110) that could become `ipc-handlers.mjs`, and secure credentials (L353–520) that could become their own module. About 40 helpers are already extracted. |
| 5 | 2,346 | `src/lib/i18n-catalog.ts` | **Yes, pure data.** `en` (L5–1172) and `ko` (L1176–2343) can be split per locale mechanically. |
| 6 | 2,018 | `server/store.ts` | **Partly.** The wire types and pure helpers (L1–655) can move. The `Store` class (L656–2018) is held together by private persistence, so splitting it needs a redesign. |
| 7 | 1,797 | `src/components/ChatView.tsx` | **Yes.** `Bubble` (L428–721), `MessagesList` (L865–1053) and the small rows can move to `chat/`. |
| 8 | 1,760 | `server/drivers/claude.ts` | **Partly.** The permission broker (L218–441, already self-contained) and the tool summaries (L475–598) can move. `sendTurn` (L843–1603) shares closure state. |
| 9 | 1,689 | `src/components/CursorAvatar.tsx` | **Yes, mostly pure data and math.** Geometry, effects, pools and motion tables (L39–1274); the component itself is about 380 lines. |
| 10 | 1,682 | `src/components/GroupView.tsx` | **Yes.** `RoomSetup` (L739–1051) and `Transcript` (L288–539). |
| 11 | 1,484 | `server/drivers/acp/core.ts` | **Partly.** WSL and env helpers (L23–79) and the `AcpSupport` interface (L80–235) can move. `sendTurn` (L595–1401) is a closure. |
| 12 | 1,408 | `src/components/ComputerPanel.tsx` | **Moderate.** One 1,260-line component. A `useComputerStatus` polling hook and 4 visual sections could be extracted. |
| 13 | 1,373 | `scripts/mcp-server.ts` | **Yes, clean layers.** Client (L6–131), the `TOOLS` table (L138–430), validation, projections, the `handleToolCall` switch (L740–1156), and the transport (L1157–1373). |
| 14 | 1,199 | `src/components/PhoneSetupFlow.tsx` | Not analysed in depth. It already exports `PhoneSetupFlowView` and a controller hook. |
| 15 | 1,169 | `server/drivers/msp/runtime.ts` | Not analysed in depth. |

Just below the cut: `server/drivers/antigravity.ts` 1,149, `server/container-computer.ts` 1,144, `src/components/Composer.tsx` 1,108, `server/computer-proxy.ts` 1,073.

**Excluded:** `electron/vendor/electron-updater.cjs` (15,937 lines, vendored bundle). Do not split it.

### 2.2 Largest test files

These matter for CI sharding.

| Lines | File |
|---|---|
| 5,773 | `server/index.test.ts` |
| 2,631 | `server/drivers/acp/acp.test.ts` |
| 2,228 | `server/drivers/claude.test.ts` |
| 2,048 | `src/components/Sidebar.test.ts` |
| 1,888 | `src/state/store.test.ts` |
| 1,725 | `server/store.test.ts` |

`server/index.test.ts` has one shared harness: `beforeAll` at L102–309 spawns `server/index.ts` once. Its `describe("harness HTTP API")` covers L319–4247 and maps cleanly onto the route areas below:
- bots and rooms (377–1138)
- teams (1643–2090)
- stop and recovery (2252–2964)
- routines (3664–3964)
- …

**Risk:** some tests probably depend on state left by earlier tests. For example, "starts empty and creates the first bot" (L377) assumes a fresh server.

### 2.3 `server/index.ts` in detail

- **Routing has no router.** `const handleRequest = async (req, res) => {…}` (L6361–L10154, about 3,800 lines) is one chain of `if (method === … && path === …)` checks plus about 70 `path.match(/…/)` regexes, ending in a static SPA fallback (L10120) and a 404 (L10148).
- **No `server/routes/` precedent exists.** Two dependency-injected handler modules already show the pattern:
  - `createWebhookIngressHandler(manager)` in `server/webhook-ingress.ts:96`
  - `serveLinkedFile(req, res, options)` in `server/linked-files.ts:245`
- **The rest of the file (about 6,000 lines)** is domain glue: config and registry, profile sync (L1142–1719), thread sync (L1720–2055), SSE fan-out (L2117–2233), a 600-line `bus.subscribe` callback (L2865–3463), turn dispatch (`startClaimedTurn` L3956–4815), the room turn engine (L5122–5830), and resume queues (L5831–6084).
- **What makes a split risky:**
  - Module-level `let` state that route handlers reassign: `profileSyncSettings` L388, `terminalBridgeAccess` L478, `deviceName` L1945, `providerConfigBusy` L6277, and the `localVm*Busy` flags L2802–2804. Moved code cannot reassign an imported binding.
  - About 40 module-level turn-state `Map`/`Set` registries.
  - Side effects at import time (L2855, L4904–4958, L10156–10161).
- **Lowest-risk extraction order:** each step is a separate PR and should be byte-for-byte behaviour-neutral.
  1. Move the `json`, `readBody`, `isLoopbackHost` and `isAllowedOrigin` helpers (L6280–6360) to `server/http.ts`. This also dedupes the `json` copies in webhook-ingress.ts and linked-files.ts.
  2. `routes/routines.ts` (L7166–7202), `routes/webhooks.ts` (L7203–7244) and `routes/static.ts` (L10119–10146, which must stay last in the chain). These are thin adapters over existing managers.
  3. `routes/voice.ts` (L9836–9878), `routes/box.ts` (L10002–10118), `routes/teams.ts` (L7677–7973), and `routes/search-export.ts` (L7540–7633).
  4. Routes that need a small state object first: sync and devices (L7309–7404), config (L9599–9835), and local-computer (L9443–9562).
  5. `/api/internal/*` (L6411–7133). It already sits behind a single `startsWith` gate.
  6. Last, after a `TurnState` object exists: groups (L7974–8293), bots (L8294–9442) and SSE (L7245–7308).

  The `/api/mailbox` route must stay **before** the auth gate (L6378 before L6398). Every extracted handler must keep its method guard, because several regexes overlap and are only disjoint by method.

---

## 3. Repo hygiene

### 3.1 Merge settings

Command: `gh api repos/aiedwardyi/Orbit`.

| Setting | Value | Note |
|---|---|---|
| `allow_squash_merge` | true | Matches the recent history: each trunk commit is a `(#NNN)` squash. |
| `allow_merge_commit` | **true** | Still allowed. The history has 256 merge commits, the latest on 2026-10-04 (`105d12bd` "Merge branches … into release-128"). |
| `allow_rebase_merge` | **true** | Still allowed. |
| `allow_auto_merge` | false | — |
| `delete_branch_on_merge` | true | Good. |
| `allow_update_branch` | false | Consider enabling it, so contributors can click "Update branch". |
| `squash_merge_commit_title` | COMMIT_OR_PR_TITLE | — |
| `has_wiki` | true | Unused. Consider turning it off so the docs stay in one place. |
| `description` | **"Private Orbit desktop release checkpoint"** | Wrong for a public repo. `homepage` is null and `topics` is empty. |

**Recommendation:** squash-only (turn off merge commits and rebase merges) for a clean `review-base`. This changes only future merges. The existing merge commits and upstream history stay as they are.

### 3.2 Stale branches

Command: `gh api repos/aiedwardyi/Orbit/branches` plus `compare/review-base...<branch>` for each branch.

- 18 branches exist. **None is stale.** Every non-trunk branch was last committed on 2026-10-07 and is `ahead`, `behind=0`.
- Only `fix/ci-green` has a PR (#311, open). The other 16 are active work branches without PRs: 11 `claude/*` session branches, `feat/phone-relay-pairing`, `feat/smooth-stream`, `fix/lost-bots-heal`, `review/relay-client` and `review/relay-service`.
- `delete_branch_on_merge: true` is already cleaning up merged branches.
- Branch names follow no single convention (`claude/…-xxxxxx`, `feat/`, `fix/`, `review/`).
- **Action:** none today. Re-check in about two weeks and delete branches with no commits for 14 days or more.

### 3.3 Templates and community files

| File | Present? | Note |
|---|---|---|
| `CONTRIBUTING.md` | Yes, but **stale and wrong** | L1 "Contributing to OpenMausBot". L26 `git clone https://github.com/milind-soni/OpenMausBot`. L22 "macOS is the primary release platform", while README and ci.yml treat Windows as primary. L50 "Ubuntu release checklist". It never mentions `review-base` as the trunk or the squash policy. |
| `.github/pull_request_template.md` | Yes | Good. It asks contributors to confirm "macOS-only code is platform-gated". |
| `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` | Yes | There is no `config.yml` to route security reports to SECURITY.md or questions elsewhere. |
| `CODEOWNERS` | **Missing** | Checked `.github/`, root and `docs/`. |
| `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `NOTICE` | Yes | `NOTICE` correctly credits OpenMausBot. |
| `.github/FUNDING.yml` | Yes | — |
| Labels | `good first issue` and `help wanted` exist | There is 1 open issue and no labelled starter issues. |

**Internal working notes are committed at the repo root:**
- `HANDOVER.md`: "Orbit 1.0.9 Handover (2026-09-15)", with orchestrator and peer-session notes.
- `REPORT.md`: "GROK-SPEED overnight report", containing the path `C:\Users\mredw\Desktop\Orbit-grok-speed`.
- `mascot-preview.html`: a 316-byte scratch page.

The last commit to touch these was `1d6a6d26` (2026-09-20). They confuse newcomers and expose a local username.

### 3.4 Does the README orient a newcomer?

**Mostly, yes.** README.md has Why, Features, Engines, Install, Run from source, an Architecture tree, Design rules, Quality gates, Release, Security, Contributing, and License and attribution (credits OpenMausBot and Ghostex).

Gaps:
- **No screenshot.** `docs/screenshots/hero.png` exists but nothing references it (§4.3).
- **Trunk not named.** The badge uses `branch=review-base`, but the text never tells contributors to branch from or target `review-base`.
- **"Quality gates" lists `pnpm lint`,** which CI does not enforce (§1.3).
- **Shells disagree.** Run-from-source uses `powershell` fences while CONTRIBUTING assumes macOS.
- **Two docs locations.** The docs live in both `docs/` (13 markdown files, plus `plans/` and `superpowers/` internal planning docs) and `apps/docs` (a Next.js site, `@openmausbot/docs`). The README's "Docs" link points at `docs/`.

---

## 4. Dead-code candidates (CANDIDATES ONLY, nothing deleted)

**Method:**
- `git ls-files` with a path resolver covering relative imports, the `@/` → `src/` alias, `.js`→`.ts` specifiers, and index files.
- Then `git grep -n -F <basename>` across all tracked files, including package.json, workflows, `electron-builder.yml` and the bundle entry lists.
- Every exported symbol was checked with `git grep -lw <name>`, excluding its own file, lockfile and `*.md`.
- Every candidate below was spot-checked by hand.

**Caveat:** word matching gives false negatives (name collisions), so the true dead set is probably *larger*.

### 4.1 Unreferenced or production-unreferenced source files

| File | Lines | Evidence |
|---|---|---|
| `server/drivers/grokagent.ts` | 4 | A back-compat re-export of `./acp/grok.ts`. `git grep -n grokagent` finds nothing outside the file. |
| `src/components/CompanionSection.tsx` | 333 | Only referenced by tests (`CompanionSection.test.ts`, `SettingsModal.test.ts`, `SettingsPolish.test.ts`, `skins.test.ts`). Commit `1e4cf035` removed its render from `SettingsModal.tsx`, yet `SettingsModal.tsx:59` still lists a `{ id: "companion" }` nav entry. **Check that:** it may be a dead nav item. |
| `src/lib/bot-order.ts` | 131 | Only `src/lib/bot-order.test.ts` imports it. |

**Maintainer scripts that no package.json script, workflow or code invokes.** These may be kept on purpose. Decide per file whether to keep, document or remove:
- `scripts/bench-thread-sync-v2{,-migration,-split}.ts` (108 / 110 / 130)
- `scripts/e2e-server.mjs` (289)
- `scripts/turn-latency-baseline.ts` (306)
- `scripts/regenerate-mac-feed.mjs` (81)
- `scripts/regenerate-blockmaps.mjs` (27)
- `scripts/caption-smoke/main.mjs` (95)
- `scripts/bench/orbit-driver-claude.ts` (179)
- `scripts/bench/turn-latency.mjs` (289): referenced only from `REPORT.md`. `orbit-driver-b.ts` depends on it.
- `scripts/generate-cua-sbom.mjs` (697): referenced only from a README.
- `scripts/make-app-icon.mjs` (312): possibly overlaps with `generate-app-icon.mjs`.

### 4.2 Unused exports

The scan covered 387 non-test `.ts`/`.tsx` files in `src/`, `server/` and `shared/`.

| Category | Count |
|---|---|
| Not referenced anywhere outside the declaration (truly dead) | 14, of which 12 are real; 2 are intentional compile-time guards in `src/lib/mascot.ts:69-70` |
| Referenced only by tests and unused in their own file (production-dead) | 47, excluding deliberate `*ForTests` / `_reset*` hooks |
| Exported but only used inside their own file (unnecessary `export`) | 461 |

**Truly dead:**
- `server/profile-sync.ts:459` `createSyncEnvelope`
- `server/bot-profile.ts:8` `BOT_PROFILE_PATCH_FIELDS`
- `src/components/ProviderIcons.tsx:100` `AntigravityMark`
- `server/drivers/rate-limits.ts:226` `museRateLimitWindows`
- `server/steer-queue.ts:118` `runningSendId`
- `server/turn-timing.ts:103` `turnTimingEnabled`, `:107` `turnTimingFile`
- `src/lib/desktop.ts:32` `browserDesktopCapabilities`
- `src/lib/mascot-art.ts:55` `mascotDataUrl`
- `server/drivers/acp/connection.ts:170` type `AcpConnection`
- `src/lib/compact-chip.ts:13` `COMPACT_SQUARE`
- `src/lib/task-recovery.ts:12` type `TaskRecoveryFlushReason`

**Production-dead (used only by tests), most significant:**
- `server/thread-sync.ts:541` `pullBotThreads`
- `server/drivers/antigravity.ts:464` `measureAntigravityTransportLengths`
- `shared/bot-avatar.ts:16` `MASCOT_STYLE_ASSETS`
- `server/profile-sync.ts:153/169/192/200`: `profileSyncRevision`, `resolveSyncConflictValue`, `unresolvedSyncConflicts`, `seenCheckpointAfterSave`
- `src/lib/sidebar-preferences.ts:104/314/323`: `stepSidebarWidth`, `loadSectionOrder`, `saveSectionOrder`
- `src/lib/sidebar-layout.ts:18/73`: `orderedSidebarSections`, `mergeSectionOrder`
- `server/skill-library.ts:109` `skillInstructionsFor`
- `src/lib/custom-models.ts:15/30`: `partitionCustomModels`, `suggestedModels`
- `src/lib/usage.ts:74` `usageChip`
- `src/lib/notify.ts:22/31`: `canClaimGetNotified`, `desktopNotificationHint`
- `src/lib/send-accept.ts:165` `visibleSteerEntries`
- `src/lib/engine-rail.ts:12/93/115`: `isEngineRailOpen`, `visibleFriendsRail`, `showFriendsLocalZoo`
- `server/drivers/local-inject.ts:393` `applyOpenAIInject`
- `server/room-error-attribution.ts:31` `providerReloadErrorActivity`
- `server/auto-approve.ts:48/52`: `looksSensitive`, `looksDestructive`. **Check that:** the tests may exercise behaviour that should be wired in, not deleted.
- `server/project-folder.ts:198` `projectSearchRoots`
- `server/steer-queue.ts:102` `markSendCancelled`
- `src/lib/chat-options.ts:108` `chatOptionChoices`
- `shared/reactions.ts:3` `PRIMARY_REACTIONS`
- `src/components/TaskPicker.tsx:22` `TASK_RENAME_HINT`
- `server/routine-requests.ts:131` type `RoutineProposalInput`

**Where unnecessary exports cluster:**
- `src/components/CursorAvatar.tsx` (23)
- `server/profile-sync.ts` (18)
- `src/lib/phone-setup.ts` (10)
- `server/skills.ts` (9)
- `src/components/ProviderIcons.tsx` (9)
- `server/config.ts`, `server/contracts.ts`, `server/thread-sync.ts` (7 each)

Removing these exports is low value. Only do it as part of a split PR that touches the file anyway.

### 4.3 Unreferenced assets

Each asset's basename was searched with `git grep -F` across the whole repo, including `apps/docs` and README.

- **All 33 files in `docs/screenshots/` (about 27 MB) are unreferenced.** That includes `hero.png` and the four `composer-dock-{before,after}.{gif,mp4}` files (about 19 MB).
- **All 6 files in `screenshots/terminal-header/` are unreferenced.**

`.git` is 56 MB. Removing these files from the tree does **not** shrink history, and history rewriting is out of scope. The options are to reference them (hero.png in the README) or remove them from the tree.

---

## 5. Prioritized plan

Each step is its own future PR, targets `review-base`, and is squash-merged. None rewrites history. Effort is S (<1h), M (half a day) or L (one or more days).

| # | Step | Effort | Risk | Why this position |
|---|---|---|---|---|
| **0** | **This audit** (`docs/repo-cleanup-audit.md`) | — | — | ✅ Done |
| 1 | **Land PR #311** (`fix/ci-green`) so trunk is green again | S | Low | Already green and mergeable. Everything else depends on a green baseline. |
| 2 | **Protect `review-base` with a ruleset:** require PRs, the Windows test and control-plane checks, no force-push or deletion; admins can bypass. Repo settings only, no code. | S | Low | Stops red merges like #303–#310. Do it right after step 1. |
| 3 | **Merge settings:** squash-only, enable "Update branch", fix the repo description, homepage and topics, turn off the wiki. Settings only. | S | Low | Future history stays linear. Existing history is untouched. |
| 4 | **CI: shard vitest 3 ways on Windows, add an oxlint job, sum test counts across shards, raise the floor to about 5,800, fix the stale comments, pin `ubuntu-24.04`, and bump the checkout pin in claude-review.** Update the required checks from step 2 to the shard names. | M | Med | About 15 → 6 min per PR and the floor guards again. Lint may need a cleanup PR first if it fails today. |
| 5 | **Contributor docs:** rewrite CONTRIBUTING for Orbit (correct clone URL, Windows primary, `review-base` trunk, squash policy, test sharding), add `.github/CODEOWNERS` and `ISSUE_TEMPLATE/config.yml`, add the trunk note and hero screenshot to the README. | S–M | Low | This is the newcomer's first impression. Docs only. |
| 6 | **Remove internal notes:** move `HANDOVER.md`, `REPORT.md` and `mascot-preview.html` out of the root (delete them, or move them to a private location). Decide on the `docs/plans` and `docs/superpowers` internal planning docs. | S | Low | Removes confusing files and the local Windows user path. Needs Edward to decide what to keep. |
| 7 | **Assets:** reference or remove the unreferenced `docs/screenshots/*` and `screenshots/terminal-header/*` files. | S | Low | About 27 MB off the working tree. History is unchanged. |
| 8 | **Dead code, batch 1:** `grokagent.ts`, `bot-order.ts`, the 12 truly dead exports, and `CompanionSection.tsx` with its tests and the `companion` nav entry, after confirming the nav item is dead. | M | Low–Med | Small, reviewable, and tests prove nothing breaks. Expect the test count to fall a little; adjust the floor in the same PR. |
| 9 | **Dead code, batch 2:** production-dead exports and their tests, plus the keep-or-remove call on the maintainer scripts (§4.1). | M | Med | Each one needs a decision: keep the test, wire it in, or remove it. |
| 10 | **Mechanical splits (pure moves, no logic changes):** one PR each for `i18n-catalog.ts` per locale, `CursorAvatar.tsx` data, `scripts/mcp-server.ts` layers, the `store.tsx` types and reducer, and the `Sidebar`/`ChatView`/`GroupView` subcomponents. | M each | Low | Big readability win at low risk. Keep them away from in-flight feature branches to avoid conflicts. |
| 11 | **`server/index.ts`, phase 1:** add `server/http.ts`, then the routines, webhooks, static, voice, box, teams and search route modules (§2.3 steps 1–3). | M–L | Med | Follows the `createWebhookIngressHandler` precedent. Covered by `server/index.test.ts`. |
| 12 | **Split `server/index.test.ts` by area,** with a shared `server/testing/harness-boot.ts`. | M | Med | Evens out the shards. Each file needs its own fixtures, and the total test count must stay at 154. |
| 13 | **`server/index.ts`, phase 2:** a `TurnState` object, then the internal, config, sync, groups, bots and SSE routes, then extract the turn and room engines. | L | **High** | Touches turn-state Maps and boot side effects. Only after steps 11–12, and only with green sharded CI. |

**Not recommended:** any history rewrite (filter-repo to drop the large GIFs, squashing old merges, rewriting authorship). It would break the attribution of about 600 upstream commits and every existing clone.
