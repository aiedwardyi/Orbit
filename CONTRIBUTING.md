# Contributing to Wink

Issues and pull requests are welcome. This file covers the dev setup, what a change is expected to meet, and what makes a PR easy to merge.

## Dev setup

Windows 10 / 11 x64 is the release platform. The server and the test suite are portable Node; CI runs on Windows.

Requirements: Node.js 24+, pnpm 10.33, and at least one engine CLI signed in (see the README).

```powershell
git clone https://github.com/aiedwardyi/Orbit.git
cd Orbit
pnpm install --frozen-lockfile

pnpm dev:server       # harness server on 127.0.0.1:8799
pnpm dev              # browser UI on http://127.0.0.1:5199
pnpm dev:desktop      # Electron shell (keeps server and Vite running)

pnpm typecheck        # app + server
pnpm build            # what CI builds
pnpm test             # vitest + grouped node tests (CI also runs relay/)
pnpm check:electron   # syntax-check the plain JS Electron entry points
pnpm package:win      # installer in release/
```

`pnpm dev:desktop` stages the pinned Cloudflare Tunnel connector before Electron starts.

## Tests

Three layers:

- **vitest**: `*.test.ts` and `*.test.mjs` under `server/`, `src/`, `shared/`, `electron/`, `companion/`, `scripts/` and `site/`. Files run one at a time; each test has a 20 s ceiling. `server/testing/setup.ts` points `HOME` at a throwaway directory, so tests never touch your real `~/.orbit`.
- **node:test**: `electron/*.node-test.mjs`, run with `node --test <file>`. `pnpm test:terminal`, `pnpm test:updater` and the other `test:*` scripts in `package.json` group them. A few files are in no group yet, so run the one you touched directly.
- **relay**: `relay/` has its own lockfile and suite. Run `pnpm check` and `pnpm test` from that directory.

`pnpm test` runs vitest behind `scripts/test-floor.mjs`, which fails the run when fewer tests register than a fixed floor. That catches a config or glob change that drops a large part of the suite, not one missing file.

Some suites boot the real server: `server/index.test.ts` and the others that import `server/index.ts`. They are the slow part of the suite. To run only the files you touched:

```powershell
pnpm exec vitest run server/foo.test.ts src/lib/bar.test.ts
node --test electron/foo.node-test.mjs
```

New server behavior comes with a test. Driver changes keep the contract tests in `server/drivers/*.test.ts` green.

## House rules

- **Spawn with argv, never a shell string.** No `shell: true`, no `cmd.exe` string building. Model names, personas and MCP config travel through argv. On Windows, resolve `.cmd` shims to their JS entry and spawn `process.execPath`.
- **Secrets are write-only.** Keys go in through the API and come back as `configured` booleans. Never log a key or echo it in a response, an event or argv.
- **Platform-specific code is gated.** `server/` stays portable Node. Native code that needs Windows, macOS or Linux lives behind a `process.platform` check. Renderer code reads the desktop capability contract (`useDesktopCapabilities`), never the OS: screen preview, dictation and local control are separate capabilities.
- **MCP tool schemas stay flat.** Each engine converts a tool's `inputSchema` for its model and drops what it can't map. No `oneOf`, `anyOf`, `allOf`, `const` or `format`; put per-variant rules in `description`s and guard the shape with a schema test, like `server/drivers/agents-proxy.test.ts`.
- **Match the altitude.** Plain Node on the server, one store, one event bus. No new runtime dependency where thirty lines will do. A new dependency needs a reason in the PR.
- **One concern per PR.** Big changes start with an issue that agrees on the approach.
- **Commits:** `type: half-sentence`, with `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf` or `ci`. No body unless it says something the diff can't.
- **Prose and comments:** terse plain English, like the README. Plain dashes, no em dashes.
- **Comments are rare and short.** Write one only where the code surprises: a footgun or a non-obvious why. Half a sentence to one short sentence; a doc comment gets one line, a second only for a real gotcha. Never narrate the next line or restate the signature. Tests get none; the name says it.
- **One voice.** Read a nearby file first and match its naming, structure and terseness. Fix old comments in code you're already changing, nowhere else; a whole-file cleanup gets its own PR.

## Before you open the PR

The pull request template asks for these:

- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] Server behavior changes come with tests
- [ ] No `dist-server/` edits (it's build output)
- [ ] Platform-specific code is gated; no `shell: true` or cmd.exe string-building
- [ ] No secrets in logs, responses, events or argv
- [ ] UI changes include before/after screenshots

## License

By contributing you agree your contributions are licensed under the [Apache License, Version 2.0](LICENSE), the same as the project.
