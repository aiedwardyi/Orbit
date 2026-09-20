# GROK-SPEED overnight report - turn latency (ACP cold TTFT)

**Branch:** `perf/turn-latency` (local only; not pushed)
**Worktree:** `C:\Users\mredw\Desktop\Orbit-grok-speed`
**Updated:** 2026-09-20 ~03:28 KST
**Improvement loops:** 3 / max 8 (stopped; Mode B at measurement floor)

## Goal

Cut Orbit ACP **cold first-turn overhead** (time-to-first-token / first visible), measured as Orbit driver path cost - not live provider model TTFT.

## Method

- `ORBIT_TURN_TIMING=1` marks on ACP/Claude/MSP send paths (`cliProbed`, `spawnOrReuse`, `cliReady`, `firstVisible`, `turnDone`, plus `reusedSession` / `reusedHandshake`).
- **Mode B:** `scripts/bench/turn-latency.mjs` + `orbit-driver-b.ts` via `createAcpDriver` + **fake-acp-cli** (happy path). Isolates Orbit ACP overhead + warm reuse.
- **Mode A (spot):** bare CLI burn once for context; not the improvement target.

Historical raw artifacts remain local under the ignored `scripts/bench/results/` directory.

## Mode A baseline (context only)

File: `2026-09-19T14-46-27-192Z.md` (A only)

| engine | TTFT median (ms) | total median (ms) |
|---|---:|---:|
| claude | 10541 | 12670 |
| grok | null | 41 |
| gemini | null | 1370 |
| muse | null | 365 |
| codex | null | 105 |

Other engines often lack TTFT marks on bare CLI; Claude ~10.5s is live provider cost, not Orbit ACP spawn.

## Mode B progression (fake-acp)

Historical results before the boot fix below. All medians ms; cold n=5, warm n=10 unless noted.

| stage | result file | cold TTFT med | warm TTFT med | cold cliReady med | cold spawnOrReuse med | notes |
|---|---|---:|---:|---:|---:|---|
| Baseline B | `2026-09-19T15-27-47-704Z` / `orbit-b-…15-27-46…` | **191** | 1 | null | 101 | cliReady mark was misplaced (null) |
| Loop 1 (instrument) | `2026-09-19T15-29-53-858Z` / `orbit-b-…15-29-52…` | **197** | 1 | **196** | 99 | cliReady moved post-handshake/pre-prompt |
| Loop 2 (CLI prefetch) | `2026-09-19T16-33-52-782Z` / `orbit-b-…16-33-51…` | **98** | 1 | **96** | **0** | `--version` at `create()`; probe off first-turn wall |
| Loop 3 (handshake prewarm) | `2026-09-19T17-34-26-085Z` / `orbit-b-…17-34-24…` | **1** | 1 | **1** | **0** | spawn+initialize(+auth) at create; cold rows `reusedHandshake: true` |

### Loop detail

1. **Loop 1 - cliReady mark fix** (`29959c22`)
   Instrumentation only. Cold breakdown on fake: ~half spawn/probe (~99ms), ~half initialize+session/new (~97ms), prompt→visible ~1-2ms.

2. **Loop 2 - create-time CLI `--version` prefetch** (`16133277`)
   `ensureCli` / probe overlapped with `refreshModels` at `create()`. Cold TTFT **197 → 98**. Remaining ~96ms = spawn+initialize+session/new on first sendTurn.

3. **Loop 3 - create-time handshake prewarm** (`7b0e25b2`)
   `beginHandshakePrewarm()` after CLI probe; create returns handshake-ready. First cold sendTurn reuses when cli/argsKey/spawnCwd match; still runs `session/new`. Cold TTFT **98 → 1**. Warm unchanged at **1**.

## Honesty

- Mode B uses **fake CLI** - measures Orbit ACP overhead, not live model TTFT.
- Loop 3 collapses Mode B cold ≈ warm because the harness **awaits create (incl. handshake)** before timing `sendTurn`. Live win depends on create finishing before the user sends the first prompt.
- Remaining live cost after these overlaps: **provider TTFT** + **`session/new` with real `mcpServers` / cwd / threadId**.
- Further `session/new` prewarm at `create()` is **not safe**: needs real turn context.

## Why stop (no Loop 4+)

Mode B cold TTFT median is already ~1ms (measurement floor). No safe behavior-preserving prewarm left without inventing turn context. Prefer this report over speculative code.

## Boot fix and merge preparation

- Registry boot calls `create()` for every instance. The previous implementation awaited CLI probing and the handshake for each one.
- Both now require instance config `prewarm: true`. Default creation performs neither; opted-in preparation runs in the background.
- Unclaimed handshakes expire after `warmIdleMs` (60 seconds by default). Borrowing or discarding clears the timer.
- The harness keeps the default cold path. The historical 1 ms result excluded awaited startup work and does not describe the revised default.
- Local history contains three commits: instrumentation, bench harness plus report, and performance changes. Raw results and overnight state are excluded.
