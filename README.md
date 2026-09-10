# Orbit

A calm, local-first desktop workspace for AI teammates.

Orbit brings Claude Code, Codex, Gemini CLI, and Grok into one polished chat app. Each bot keeps its own identity, model, thread, workspace, memory, tools, and approval history.

## What is included

- Persistent one-to-one chats and multi-agent rooms
- Model switching without losing the conversation
- Claude, Codex, Gemini, and Grok subscription logins
- File attachments, generated-file downloads, and rich Markdown
- Tool approvals, secret requests, and inspectable activity
- Per-bot browser sessions and optional computer control
- Connected apps, webhooks, routines, voice, and reusable skills
- Local transcripts and settings under `~/.orbit`
- Usage analytics off by default

## Providers

| Provider | Local command | Authentication |
| --- | --- | --- |
| Claude Code | `claude` | Existing Claude Code login |
| Codex | `codex` | Existing Codex login |
| Gemini subscription | `agy` | Existing Antigravity login |
| Gemini API | `gemini --acp` | Gemini API key |
| Grok | `grok` | Existing Grok login |

Orbit detects installed engines during setup. More compatible engines remain available under Settings.

## Run from source on Windows

Requirements: Node.js 24 or newer and pnpm 10.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5199`.

`pnpm dev` starts the harness and Vite together. The harness sends its fresh app token to the launcher over private IPC; the launcher passes it to Vite through `OMB_COMMS_TOKEN`. Vite adds the upstream header for `/api` requests, including streams and attachments. The token stays out of browser code, URLs, and files. Stop and restart the launcher to rotate it.

Use `pnpm dev:desktop` to start the same pair with the desktop app. The desktop passes the token privately to Companion after its device authentication. Standalone helpers must inherit `OMB_COMMS_TOKEN` from their trusted launcher; `pnpm dev:server` alone provides no browser access to data routes.

## Build the Windows app

```powershell
pnpm package:win
```

Installers and portable archives are written to `release/`. The installer is currently unsigned, so Windows SmartScreen may show an unknown-publisher warning.

## Quality checks

```powershell
pnpm typecheck
pnpm lint
pnpm check:contrast
pnpm test
pnpm build
```

## License and attribution

Orbit is based on [OpenMausBot](https://github.com/milind-soni/OpenMausBot) and is distributed under the Apache License 2.0. See `LICENSE` and `NOTICE`.

The cross model picker uses [Ghostex](https://github.com/maddada/Ghostex) (MIT) as its design source.
