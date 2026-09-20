# REAL-TURN — live Claude cold vs warm (Orbit driver)

**Branch:** `perf/prewarm-on` (local only; not pushed)  
**Worktree:** `C:\Users\mredw\Desktop\Orbit-prewarm`  
**Measured:** 2026-09-20 ~11:14 KST  
**SHA at measure:** see commits below / `git log -1 --oneline`  
**Harness:** `scripts/bench/orbit-driver-claude.ts` → `ClaudeDriver` + real `claude` CLI  
**Prompt:** `Reply with exactly: ok` · **n:** 5 cold + 5 warm · **failures:** 0

## Method

1. **Cold:** dispose + recreate driver instance each turn (fresh CLI spawn/handshake).
2. **Warm:** same thread + `resumeCursor` so Orbit reuses the retained Claude process.
3. **`ORBIT_TURN_TIMING=1`** writes `<OMB_DATA_DIR>/turn-timing.jsonl` with Orbit marks:
   - `dispatchMs` → `spawnOrReuseMs` → `cliReadyMs` → `firstVisibleMs` → `turnDoneMs`
4. Wall TTFT also taken from first `content.delta` (matches `firstVisibleMs` when timing fires).

**Not in this harness (in-app only):** keypress → IPC → `post.received` / `prepare.completed`. Those stages are covered by `OMB_CHAT_LATENCY=1` (`markChatLatency` in `server/index.ts`). This file is the **driver → CLI → first token** slice.

Composer **focus / first keystroke** now calls `POST /api/bots/:id/prewarm` so ACP `prepare()` can overlap handshake before send (separate from Claude session reuse).

## Medians (ms)

| condition | TTFT (firstVisible) | total | cliReady (Orbit) | spawnOrReuse (Orbit) | dispatch (Orbit) |
|---|---:|---:|---:|---:|---:|
| **Cold** | **2924** | **3084** | **21** | **0** | **0** |
| **Warm** | **1543** | **1641** | **0** | **0** | **0** |

Raw run: `scripts/bench/results/claude-real-20260920-111411/` (gitignored).

### Per-turn wall TTFT / total

| # | kind | TTFT | total | cliReady |
|--:|---|---:|---:|---:|
| 1 | cold | 2989 | 3140 | 22 |
| 2 | cold | 2894 | 3037 | 27 |
| 3 | cold | 2924 | 3084 | 19 |
| 4 | cold | 2878 | 3019 | 21 |
| 5 | cold | 2966 | 3157 | 19 |
| 6 | warm* | 3355 | 3494 | 25 |
| 7 | warm | 1517 | 1633 | 0 |
| 8 | warm | 1598 | 1722 | 0 |
| 9 | warm | 1543 | 1641 | 0 |
| 10 | warm | 1351 | 1489 | 0 |

\*First warm after colds still paid a full spawn (`cliReady` 25) before session reuse kicked in on turns 7–10.

## Orbit vs provider

| Segment | Owner | Cold | Warm (reuse) | Notes |
|---|---|---:|---:|---|
| `dispatch` | Orbit | ~0 | ~0 | In-process |
| `spawnOrReuse` + `cliReady` | Orbit | ~21 | **0** | Spawn/handshake vs retained stdin write |
| `cliReady` → `firstVisible` | **Provider** | ~2900 | ~1540 | Model TTFT + stream |
| `firstVisible` → `turnDone` | Mixed | ~160 | ~100 | Short reply; mostly provider flush |

**Conclusion:** After focused-bot prewarm / session reuse, **remaining latency to first token is almost entirely provider-bound**. Orbit-owned spawn/ready is ~20ms cold and ~0ms on warm reuse. Do not chase provider TTFT in Orbit code.

## Orbit fixes landed with this measurement

1. Focused-bot `prepare()` + Composer focus/keystroke → `/api/bots/:id/prewarm` (boot still cold).
2. Claude turn timing: `cliReady` / `firstVisible` marks; `finish()` on happy-path `settle`; per-turn `timer` on `session.turn` so **warm reuse** records its own line (previously warm reused the cold timer and skipped `finish`).

## Honesty

- Live Claude Code CLI (subscription), not fake-acp.
- Short ping prompt — good for overhead split, not for long-generation totals.
- Headless driver bench ≠ full UI keypress→paint; use chat-latency env for the IPC/UI head.

