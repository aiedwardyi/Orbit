# Orbit agent instructions

## Start every session

- Read `README.md`, `QA_PROMPT.md`, and `POLISH_BOARD.md` completely.
- Read `%USERPROFILE%\My Drive\Obsidian\Eddie_Brain\Projects\orbit defaults and smoother onboarding\00_START_HERE.md` and every file it marks required.
- Verify the branch, HEAD, worktree, remotes, and running Orbit processes before relying on recorded state.
- Treat repository code and tests as implementation truth. Treat `POLISH_BOARD.md` as the defect-status authority. Treat the Obsidian brain as product intent.

## Product north star

Orbit is a home for permanent AI employees, not a terminal wrapped in chat UI. Each bot must retain its role, relationship, memory, work state, evidence, and next action across long conversations, compaction, model changes, and restarts. A new user must understand the job-first workflow and begin useful work within five minutes.

- Default path: describe the job, accept the generated identity, leave Model on Automatic, and start working.
- Ask for access only when the work needs it.
- Keep exact models, effort, computer backends, folders, memory editing, peer rules, and approval policy available under progressive disclosure.
- Preserve Orbit's model-neutral, local-first identity. Do not copy another product's branding or assets.
- Perfect the desktop employee workflow before returning phone and mobile integration to primary navigation.

## Execution card

Before every task or delegation, print this card. Separate multiple cards with a line of hyphens.

```text
TASK: <ID and outcome>
SESSION: CURRENT <role/chat> or NEW <new chat name>
HARNESS: <Codex, Cursor Agent, Claude Code, or exact environment>
MODEL: <one exact model>
EFFORT/MODE: <one exact setting>
RUN: NOW - SEQUENTIAL, PARALLEL GROUP <letter>, or AFTER <task ID>
ACCESS: READ-ONLY, ISOLATED WORKTREE, or CHIEF-ONLY WRITE
WHY: <one sentence>
RETURN TO: Atlas
PROMPT:
<complete copy-paste prompt>
```

Use GPT-5.6 Sol Ultra for Atlas coordination, GPT-5.6 Sol Max for integration, Cursor Grok 4.6 XHigh Fast for visual UX, Claude Fable 5 at the highest effort for one hard architecture review, and Claude Opus 5 at the highest effort for independent review. Select the closest visible frontier substitute when unavailable. Never ask the user to choose.

## Ownership and safety

- Atlas is the sole integration owner. Parallel agents stay read-only or use isolated worktrees.
- Never allow two agents to edit the same worktree.
- Work only inside the Orbit repository. The only standing exception is the Orbit Obsidian project memory named above.
- Never stop, kill, or interrupt running processes without the user's explicit action-naming permission.
- Never read, modify, or erase the real `~/.orbit` profile. Use isolated QA profiles.
- Never expose credentials. Do not push to `origin`, which is the public OpenMausBot upstream.
- Push only to the private `checkpoint` remote, and only with explicit user authorization.

## End every material session

- Update `POLISH_BOARD.md` only from verified evidence.
- Update the Obsidian `UPDATE_LOG.md`, `BUG_REGISTRY.md`, and `BRAIN.md` when facts, decisions, or priorities materially change.
- Write a current handoff under `%USERPROFILE%\.codex\handoffs` before clearing context.
- Record exact verification, unfinished work, blockers, running processes, and one next action. Never store secrets.
