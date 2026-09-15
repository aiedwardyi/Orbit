# Orbit 1.0.9 Handover (2026-09-15)

## Where things stand
- Branch `review-base`, HEAD `1823b549` (pushed to `checkpoint` remote = github.com/aiedwardyi/Orbit).
- v1.0.8 is live as Latest on `aiedwardyi/orbit-releases`. `package.json` already bumped to 1.0.9.
- All 3 user-reported 1.0.9 fixes are implemented + peer-verified:
  - `d93c16fe` top-right engine dot + sidebar dot-model rows (no preview) — work3 verified 5/5.
  - `caf67db4` Bot-details Model stacked layout — work verified all-PASS.
  - `1823b549` vitest reds: Sidebar wait race, MSP `protocol.ts` strip-types boot, stale Grok xhigh test.
- Linux vitest harness: `~/v-linuxtest` (full `pnpm install`, must NOT live under /tmp — the DEB-hook
  tests assert the repo root is outside /tmp). Pre-fix it reproduced Edward's exact 9 Windows failures.

## Left to do (Windows, Edward)
```
git checkout review-base
git pull
pnpm vitest run
pnpm package:win
gh release create v1.0.9 -R aiedwardyi/orbit-releases release/Orbit-1.0.9-setup.exe release/Orbit-1.0.9-setup.exe.blockmap release/latest.yml --title "Orbit 1.0.9" --latest
```
- If `vitest run` is green, publish. Builder output dir is `release/` (see `electron-builder.yml`).

## Open decisions for Edward
- Waiting-for-you card: keep it, or restore auto-opening the room?
- Per-instance unrestricted/yolo spawn.
- Manually delete `qa-themes` scratch (Chrome lock blocked it).

## Notes for whoever continues
- Peer sessions `work` / `work2` / `work3` share this workspace; orchestrator talks to them via
  `send_session_message`. All 1.0.9 tickets are closed; work3's last ticket was stood down (self-landed).
- `node_modules` in the live tree is a WINDOWS install — vitest/tsc run from it under WSL will fail
  on platform binaries. Use `~/v-linuxtest` for Linux test runs (`git pull` to sync).
- Server boots in tests via `node --experimental-strip-types`: no TS parameter properties, enums, or
  namespaces in `server/` / `shared/` / `companion/` (non-test). tsc will not catch these — only boot does.
- Session state also in personal memory `orbit-ship-state.md`.

## 1.0.10 (same day)
- `330eb9a4`: chip single dot (dropped middot separator next to engine dot), sidebar model names use
  full row width (no more "..." truncation), wizard shows "describe the job to unlock Add bot" hint.
  Version bumped to 1.0.10. Focused suites 7/7 green on Linux (170 tests).
- Windows publish: same 5 lines as above with v1.0.10 / Orbit-1.0.10-setup.exe.
- Note: wizard job field intentionally NOT renamed to "name" — its value becomes the bot's job brief
  AND auto-derives the name (botNameFromJob). The hint explains the real requirement.
