<div align="center">

# Orbit

**A calm, local-first desktop workspace for AI teammates.**

One window for Claude Code, Codex, Gemini, Grok, and Meta Muse.
Every bot keeps its own identity, model, memory, workspace, tools, and approval history.

[![CI](https://github.com/aiedwardyi/Orbit/actions/workflows/ci.yml/badge.svg?branch=review-base)](https://github.com/aiedwardyi/Orbit/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/aiedwardyi/orbit-releases?label=release)](https://github.com/aiedwardyi/orbit-releases/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](electron/)

[Download](https://github.com/aiedwardyi/orbit-releases/releases/latest) · [Docs](docs/) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

</div>

---

## Why Orbit

Agent CLIs are powerful and lonely. Each one lives in its own terminal, forgets who it is between sessions, and asks you to re-explain the project every morning.

Orbit turns those CLIs into a team you can talk to. It wraps the subscriptions you already pay for, keeps every conversation on your disk, and never routes a message through a server you do not run.

- **Local-first.** Transcripts, settings, memory, and attachments live under `~/.orbit`. No account, no cloud relay, analytics off by default.
- **Bring your own login.** Orbit drives the official CLIs (`claude`, `codex`, `agy`, `grok`, `muse`) with the sessions you already have. No API keys required.
- **Persistent teammates.** A bot is a profile, not a tab: name, role, colour, model, memory document, workspace folder, and tool permissions survive restarts and model switches.
- **Switch models mid-thread.** Move a conversation from Fable to Opus to Gemini without losing context.
- **Fast on purpose.** Turn latency, first-paint, and chat rendering are measured and regression-tested.

## Features

| Area | What you get |
| --- | --- |
| Chat | One-to-one threads, multi-bot channels, rich Markdown, file attachments, generated-file downloads |
| Control | Tool approvals, secret requests via secure in-app cards, inspectable activity per turn |
| Tools | Per-bot browser sessions, optional computer control, connected apps, webhooks, routines, voice, reusable skills |
| Terminals | Embedded terminal panes for long-running worker agents, wheel scroll and mouse support in TUIs |
| Sync | Manual profile sync (Save / Preview / Import) across PCs through a folder you choose, such as Google Drive |
| Locale | English and Korean, chosen per machine in Settings |
| Updates | In-app updater with hash-verified release feed, acknowledged per version |

## Engines

| Engine | Local command | Auth |
| --- | --- | --- |
| Claude Code | `claude` | Existing Claude Code login |
| Codex | `codex` | Existing Codex login |
| Gemini (subscription) | `agy` | Existing Antigravity login |
| Gemini (API) | `gemini --acp` | Gemini API key |
| Grok | `grok` | Existing Grok login |
| Meta Muse | `muse` (WSL on Windows) | Existing Muse login |

Orbit detects installed engines at setup. Any compatible engine can be enabled later under **Settings → Engines**.

## Install

Grab the latest Windows installer from [orbit-releases](https://github.com/aiedwardyi/orbit-releases/releases/latest).

The installer is currently unsigned, so SmartScreen may show an unknown-publisher warning on first run. Linux packaging exists as a beta workflow; see [docs/linux-desktop.md](docs/linux-desktop.md).

## Run from source

Requirements: Node.js 24+ and pnpm 10.

```powershell
git clone https://github.com/aiedwardyi/Orbit.git
cd Orbit
pnpm install --frozen-lockfile
pnpm dev            # harness + Vite, open http://127.0.0.1:5199
pnpm dev:desktop    # same pair inside the Electron shell
```

`pnpm dev` starts the harness server and Vite together. The harness mints a fresh app token per launch and hands it to Vite over private IPC. The token never appears in browser code, URLs, or files. Restart the launcher to rotate it.

## Architecture

```
electron/    Electron shell: window, updater, IPC, packaged-server boot
server/      Harness: plain Node, one store, one event bus, engine drivers
  drivers/   One driver per engine (claude, codex, grok, antigravity, acp, msp, ...)
src/         React 19 + Vite renderer: chat, settings, terminals, bot roster
companion/   Device-authenticated helper for the desktop app
shared/      Types and helpers shared by server and renderer
cloudflare/  Optional Workers: control plane and Composio broker
ios/         iOS companion
apps/docs    Documentation site
scripts/     Dev launcher, packaging, MCP server, quality gates
```

Design rules that keep the codebase small:

- **No framework on the server.** Plain Node with `--experimental-strip-types`. A dependency needs a reason.
- **One store, one event bus.** State changes are events the renderer subscribes to.
- **Drivers are thin.** A driver adapts one CLI's protocol to Orbit's turn contract and nothing else.
- **Tests inject, never spawn.** Driver tests use injected runners so the suite never launches a real CLI.

Orbit also ships a local stdio [MCP server](docs/mcp-server.md) so another MCP client can coordinate your team while the app is running.

## Quality gates

```powershell
pnpm typecheck        # tsc for renderer + server
pnpm lint             # oxlint
pnpm check:contrast   # WCAG contrast on every skin
pnpm vitest run server/drivers   # targeted suites (fast, no real CLIs)
pnpm test             # full suite: vitest, node --test, packaged-server boot probe
pnpm build
```

Server changes need tests. UI changes need before/after screenshots. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Build and release

```powershell
pnpm package:win      # installer + portable archive in release/
```

Releases are cut by a single GitHub Actions workflow that packages a pinned commit, verifies the artifact the way a user receives it, and publishes to [orbit-releases](https://github.com/aiedwardyi/orbit-releases). Each verification gate maps to a real past incident. Read [docs/releasing.md](docs/releasing.md) before removing one.

## Security

Orbit runs agents that can read files, run commands, and browse. Every tool call goes through an approval card, secrets are requested through in-app cards rather than chat, and the harness API is only reachable with the per-launch token.

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Contributing

Small, focused PRs. One concern each. Match the existing altitude: thirty lines of plain code beat a new dependency. Details in [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License and attribution

Orbit is a derivative work of [OpenMausBot](https://github.com/milind-soni/OpenMausBot), distributed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The cross-model picker uses [Ghostex](https://github.com/maddada/Ghostex) (MIT) as its design source.
