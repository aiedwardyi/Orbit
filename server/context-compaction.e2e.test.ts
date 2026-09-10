import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { PRE_COMPACT_TOOL_ROUND_LIMIT } from "./turn-context.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CODEX_CLI = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const BOT_ID = "compaction-bot";
const THREAD_ID = "compaction-thread";
const CLAUDE_BOT_ID = "compaction-claude-bot";
const CLAUDE_THREAD_ID = "compaction-claude-thread";
const CLAUDE_RESUME = {
  botId: "compaction-claude-resume-bot",
  threadId: "compaction-claude-resume-thread",
  fatSession: "fat-session-abc",
};
const CLAUDE_FAT = {
  botId: "compaction-claude-fat-bot",
  threadId: "compaction-claude-fat-thread",
  fatSession: "fat-soak-session",
};
const CLAUDE_FAT_STOP = {
  botId: "compaction-claude-fat-stop-bot",
  threadId: "compaction-claude-fat-stop-thread",
  fatSession: "fat-soak-stop-session",
};
const CLAUDE_SLIM = {
  botId: "compaction-claude-slim-bot",
  threadId: "compaction-claude-slim-thread",
  session: "slim-session",
};

function claudeResumeBot(input: {
  id: string;
  threadId: string;
  name: string;
  color: string;
  session: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    name: input.name,
    title: "Release owner",
    description: "Keep the release moving.",
    notifications: true,
    color: input.color,
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-fake" },
    resumeCursors: { claude: input.session },
    createdAt: 1,
    tasks: [{
      threadId: input.threadId,
      title: "Release",
      createdAt: 1,
      resumeCursors: { claude: input.session },
      lastInstanceId: "claude",
      lastModel: "claude-fake",
    }],
  };
}
const ROOM_FIRST = {
  botId: "room-first-bot",
  botThreadId: "room-first-direct-thread",
  groupId: "room-first-group",
  roomThreadId: "room-first-room-thread",
};
const DIRECT_FIRST = {
  botId: "direct-first-bot",
  botThreadId: "direct-first-direct-thread",
  groupId: "direct-first-group",
  roomThreadId: "direct-first-room-thread",
};
const ROOM_TASK = {
  botId: "room-task-bot",
  botThreadId: "room-task-direct-thread",
  groupId: "room-task-group",
  roomThreadId: "room-task-room-thread",
};
const ROOM_TASK_NEXT = { botId: "room-task-next-bot", botThreadId: "room-task-next-thread" };
const ROOM_TASK_SURVIVOR = { botId: "room-task-survivor-bot", botThreadId: "room-task-survivor-thread" };
const EDIT_CLAIM = { botId: "edit-claim-bot", botThreadId: "edit-claim-thread" };
const NEW_TASK_CLAIM = { botId: "new-task-claim-bot", botThreadId: "new-task-claim-thread" };
const CLEAR_RACE = { botId: "clear-race-bot", botThreadId: "clear-race-thread" };
const GOAL_STRIP = { botId: "goal-strip-bot", botThreadId: "goal-strip-thread" };
const GOAL_LEGACY = { botId: "goal-legacy-bot", botThreadId: "goal-legacy-thread" };
const GOAL_OWNED = { botId: "goal-owned-bot", botThreadId: "goal-owned-thread" };
const PLAN_SEED = { botId: "plan-seed-bot", botThreadId: "plan-seed-thread" };
const PLAN_ONLY = { botId: "plan-only-bot", botThreadId: "plan-only-thread" };
const GOAL_ONLY = { botId: "goal-only-bot", botThreadId: "goal-only-thread" };
const PLAN_CLEARED = { botId: "plan-cleared-bot", botThreadId: "plan-cleared-thread" };
const SECRET_COLLISION = {
  botId: "secret-collision-bot",
  botThreadId: "secret-collision-direct-thread",
  groupId: "secret-collision-group",
  roomThreadId: "secret-collision-room-thread",
};

interface TaskStateFields {
  goal?: string;
  plan?: Array<{ step: string; status: "pending" | "active" | "done" | "skipped" }>;
}

type ApiBody =
  | { text: string }
  | { title: string }
  | { threadId: string }
  | { memberIds: string[] }
  | { cwd: string | null };

describe("context compaction e2e", () => {
  let child: ChildProcess;
  let home: string;
  let dumpPath: string;
  let claudeDumpPath: string;
  let clearRaceProject: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const storedTaskPacket = (threadId: string) =>
    JSON.parse(readFileSync(join(home, ".orbit", "task-state", `${threadId}.json`), "utf8"));
  const botById = async (botId: string) =>
    (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
  /** Drive update_task_state the way the agents-proxy does, with the token the turn handed it. */
  const botTaskState = (botId: string, threadId: string, fields: TaskStateFields) => {
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    return fetch(`${BASE}/api/internal/task-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: botId, fromThreadId: threadId, ...fields }),
    });
  };

  const waitFor = async (predicate: () => Promise<boolean>, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for server state. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CODEX_CLI, 0o755);
    chmodSync(FAKE_CLAUDE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "orbit-compaction-e2e-"));
    dumpPath = join(home, "codex-dump.json");
    claudeDumpPath = join(home, "claude-dump.json");
    clearRaceProject = join(home, "clear-race-project");
    mkdirSync(clearRaceProject);
    const dataDir = join(home, ".orbit");
    mkdirSync(join(dataDir, "task-state"), { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        codex: {
          driver: "codex",
          environment: { FAKE_CODEX_DUMP: dumpPath },
          config: { cli: FAKE_CODEX_CLI },
        },
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_DUMP: claudeDumpPath,
            FAKE_CLAUDE_GENERATE_DELAY_MS: "1500",
          },
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }));
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
      {
        id: BOT_ID,
        threadId: THREAD_ID,
        name: "Continuity",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: CLAUDE_BOT_ID,
        threadId: CLAUDE_THREAD_ID,
        name: "Summary",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: CLAUDE_THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      claudeResumeBot({
        id: CLAUDE_RESUME.botId,
        threadId: CLAUDE_RESUME.threadId,
        name: "Resume recycle",
        color: "teal",
        session: CLAUDE_RESUME.fatSession,
      }),
      claudeResumeBot({
        id: CLAUDE_FAT.botId,
        threadId: CLAUDE_FAT.threadId,
        name: "Fat soak recycle",
        color: "orange",
        session: CLAUDE_FAT.fatSession,
      }),
      claudeResumeBot({
        id: CLAUDE_FAT_STOP.botId,
        threadId: CLAUDE_FAT_STOP.threadId,
        name: "Fat soak stop",
        color: "red",
        session: CLAUDE_FAT_STOP.fatSession,
      }),
      claudeResumeBot({
        id: CLAUDE_SLIM.botId,
        threadId: CLAUDE_SLIM.threadId,
        name: "Slim resume",
        color: "gray",
        session: CLAUDE_SLIM.session,
      }),
      {
        id: ROOM_FIRST.botId,
        threadId: ROOM_FIRST.botThreadId,
        name: "Room first",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_FIRST.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: DIRECT_FIRST.botId,
        threadId: DIRECT_FIRST.botThreadId,
        name: "Direct first",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: DIRECT_FIRST.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK.botId,
        threadId: ROOM_TASK.botThreadId,
        name: "Room continuity",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK_NEXT.botId,
        threadId: ROOM_TASK_NEXT.botThreadId,
        name: "Next owner",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK_NEXT.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK_SURVIVOR.botId,
        threadId: ROOM_TASK_SURVIVOR.botThreadId,
        name: "Survivor",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK_SURVIVOR.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: EDIT_CLAIM.botId,
        threadId: EDIT_CLAIM.botThreadId,
        name: "Edit guard",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: EDIT_CLAIM.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: NEW_TASK_CLAIM.botId,
        threadId: NEW_TASK_CLAIM.botThreadId,
        name: "Task guard",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: NEW_TASK_CLAIM.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_OWNED.botId,
        threadId: GOAL_OWNED.botThreadId,
        name: "Goal owned",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_OWNED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_ONLY.botId,
        threadId: GOAL_ONLY.botThreadId,
        name: "Goal only",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_ONLY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_CLEARED.botId,
        threadId: PLAN_CLEARED.botThreadId,
        name: "Plan cleared",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_CLEARED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_ONLY.botId,
        threadId: PLAN_ONLY.botThreadId,
        name: "Plan only",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_ONLY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_SEED.botId,
        threadId: PLAN_SEED.botThreadId,
        name: "Plan seed",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_SEED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_STRIP.botId,
        threadId: GOAL_STRIP.botThreadId,
        name: "Goal strip",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_STRIP.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_LEGACY.botId,
        threadId: GOAL_LEGACY.botThreadId,
        name: "Goal legacy",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_LEGACY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: CLEAR_RACE.botId,
        threadId: CLEAR_RACE.botThreadId,
        name: "Clear race",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        lastProjectCwd: clearRaceProject,
        createdAt: 1,
        tasks: [{ threadId: CLEAR_RACE.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: SECRET_COLLISION.botId,
        threadId: SECRET_COLLISION.botThreadId,
        name: "Secret retry",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: SECRET_COLLISION.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
    ]));
    writeFileSync(join(dataDir, "groups.json"), JSON.stringify([
      {
        id: ROOM_FIRST.groupId,
        threadId: ROOM_FIRST.roomThreadId,
        name: "Room first race",
        memberIds: [ROOM_FIRST.botId],
        defaultResponder: { kind: "member", botId: ROOM_FIRST.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: ROOM_FIRST.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: DIRECT_FIRST.groupId,
        threadId: DIRECT_FIRST.roomThreadId,
        name: "Direct first race",
        memberIds: [DIRECT_FIRST.botId],
        defaultResponder: { kind: "member", botId: DIRECT_FIRST.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: DIRECT_FIRST.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: ROOM_TASK.groupId,
        threadId: ROOM_TASK.roomThreadId,
        name: "Room continuity",
        memberIds: [ROOM_TASK.botId, ROOM_TASK_NEXT.botId, ROOM_TASK_SURVIVOR.botId],
        defaultResponder: { kind: "member", botId: ROOM_TASK.botId },
        bulletin: "Preserve verified release evidence.",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: SECRET_COLLISION.groupId,
        threadId: SECRET_COLLISION.roomThreadId,
        name: "Secret retry",
        memberIds: [SECRET_COLLISION.botId],
        defaultResponder: { kind: "member", botId: SECRET_COLLISION.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: SECRET_COLLISION.roomThreadId, title: "Release", createdAt: 1 }],
      },
    ]));
    const messages = Array.from({ length: 97 }, (_, index) => ({
      id: `m${index}`,
      at: index + 1,
      parentId: index ? `m${index - 1}` : null,
      role: index % 2 === 0 ? "user" : "bot",
      kind: "text",
      text: `history ${index}`,
    }));
    for (const threadId of [
      THREAD_ID,
      CLAUDE_THREAD_ID,
      CLAUDE_RESUME.threadId,
      ROOM_FIRST.botThreadId,
      ROOM_FIRST.roomThreadId,
      DIRECT_FIRST.botThreadId,
      DIRECT_FIRST.roomThreadId,
      ROOM_TASK.roomThreadId,
      EDIT_CLAIM.botThreadId,
      NEW_TASK_CLAIM.botThreadId,
      CLEAR_RACE.botThreadId,
      SECRET_COLLISION.botThreadId,
      SECRET_COLLISION.roomThreadId,
    ]) {
      writeFileSync(join(dataDir, `messages-${threadId}.json`), JSON.stringify({
        activeLeafId: "m96",
        messages,
      }));
    }
    const fatMessages = [
      { id: "f0", at: 1, parentId: null, role: "user", kind: "text", text: "inspect the tree" },
      ...Array.from({ length: PRE_COMPACT_TOOL_ROUND_LIMIT }, (_, index) => ({
        id: `ft${index}`,
        at: index + 2,
        parentId: index === 0 ? "f0" : `ft${index - 1}`,
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${index}.ts`, ok: true },
      })),
      {
        id: "fa",
        at: PRE_COMPACT_TOOL_ROUND_LIMIT + 2,
        parentId: `ft${PRE_COMPACT_TOOL_ROUND_LIMIT - 1}`,
        role: "bot",
        kind: "text",
        text: "tree inspected",
      },
    ];
    const slimMessages = [
      { id: "s0", at: 1, parentId: null, role: "user", kind: "text", text: "say hi" },
      { id: "st0", at: 2, parentId: "s0", role: "bot", kind: "activity", tool: { name: "Read: readme.md", ok: true } },
      { id: "st1", at: 3, parentId: "st0", role: "bot", kind: "activity", tool: { name: "Read: note.md", ok: true } },
      { id: "sa", at: 4, parentId: "st1", role: "bot", kind: "text", text: "hello" },
    ];
    writeFileSync(join(dataDir, `messages-${CLAUDE_FAT.threadId}.json`), JSON.stringify({
      activeLeafId: "fa",
      messages: fatMessages,
    }));
    writeFileSync(join(dataDir, `messages-${CLAUDE_FAT_STOP.threadId}.json`), JSON.stringify({
      activeLeafId: "fa",
      messages: fatMessages,
    }));
    writeFileSync(join(dataDir, `messages-${CLAUDE_SLIM.threadId}.json`), JSON.stringify({
      activeLeafId: "sa",
      messages: slimMessages,
    }));
    writeFileSync(join(dataDir, "task-state", `${CLAUDE_FAT_STOP.threadId}.json`), JSON.stringify({
      v: 1,
      threadId: CLAUDE_FAT_STOP.threadId,
      botId: CLAUDE_FAT_STOP.botId,
      goal: "Inspect the tree",
      plan: [{ step: "Keep reading files", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Keep reading files",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "stop",
      turnsAtWrite: 0,
    }));
    // Neither anchor field: the record shape written before instructionAction and instructionGoal existed.
    writeFileSync(join(dataDir, "task-state", `${GOAL_LEGACY.botThreadId}.json`), JSON.stringify({
      v: 1,
      threadId: GOAL_LEGACY.botThreadId,
      botId: GOAL_LEGACY.botId,
      goal: "Ship the legacy release",
      plan: [{ step: "Run legacy smoke tests", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Run legacy smoke tests",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));
    for (const [threadId, botId] of [[THREAD_ID, BOT_ID], [CLAUDE_THREAD_ID, CLAUDE_BOT_ID]]) {
      writeFileSync(join(dataDir, "task-state", `${threadId}.json`), JSON.stringify({
        v: 1,
        threadId,
        botId,
        goal: "Ship the release",
        plan: [{ step: "Run smoke tests", status: "active" }],
        completed: [{ note: "Built the installer", at: 1 }],
        evidence: [{ kind: "file", ref: "reports/green.json" }],
        artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
        blockers: [],
        nextAction: "Run smoke tests",
        updatedAt: 1,
        updatedBy: "harness",
        flushReason: "progress",
        turnsAtWrite: 0,
      }));
    }
    writeFileSync(join(dataDir, "task-state", `${ROOM_TASK.roomThreadId}.json`), JSON.stringify({
      v: 1,
      threadId: ROOM_TASK.roomThreadId,
      botId: ROOM_TASK.botId,
      goal: "Ship the room release",
      plan: [{ step: "Verify the room package", status: "active" }],
      completed: [{ note: "Built the room installer", at: 1 }],
      evidence: [{ kind: "file", ref: "reports/room-green.json", note: "room checks passed" }],
      artifacts: [{ ref: "dist/room-orbit.exe", label: "Room installer" }],
      blockers: [{ kind: "approval", note: "Awaiting release approval" }],
      nextAction: "Verify the room package",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        return false;
      }
    });
    await waitFor(async () => {
      const instances = (await api("GET", "/api/instances")).body.instances;
      return ["codex", "claude"].every((instanceId) =>
        instances.find((instance: { instanceId: string }) => instance.instanceId === instanceId)?.snapshot.state === "available",
      );
    });
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("dispatches a long thread through a driver without generateText", async () => {
    const sent = await api("POST", `/api/bots/${BOT_ID}/messages`, { text: "Continue with final QA" });
    expect(sent.status).toBe(202);

    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === BOT_ID,
      );
      return bot?.busy;
    }, { timeout: 10_000 }).toBe(false);

    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const turn = dump.calls.find((call: { method: string }) => call.method === "turn/start");
    const prompt = turn.params.input[0].text;
    expect(prompt).toContain("Goal: Ship the release");
    expect(prompt).toContain("reports/green.json");
    expect(prompt).toContain("dist/orbit.exe");
    expect(prompt).toContain("history 0");
    expect(prompt).toContain("history 96");

    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === BOT_ID,
    );
    expect(bot.messages.filter((message: { kind: string }) => message.kind === "compaction")).toHaveLength(1);
    expect(bot.messages.some((message: { text?: string }) => message.text === "history 0")).toBe(true);
    expect(JSON.stringify(bot.messages)).not.toContain("cannot summarize it");
  }, 30_000);

  it("does not --resume a fat Claude soak before the first Orbit compact", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_FAT.botId}/messages`, {
      text: "now commit",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_FAT.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    expect(dump.argv).not.toContain(CLAUDE_FAT.fatSession);
    expect(dump.argv).toContain("--session-id");
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).toContain("fresh provider session");
    expect(prompt).not.toContain("Orbit compacted this conversation");
    expect(prompt).toContain("tree inspected");
  }, 30_000);

  it("still --resumes Stop recovery on an uncompacted fat Claude soak", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_FAT_STOP.botId}/messages`, {
      text: "continue",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_FAT_STOP.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain(CLAUDE_FAT_STOP.fatSession);
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).not.toContain("fresh provider session");
    expect(prompt).not.toContain("Orbit compacted this conversation");
  }, 30_000);

  it("still --resumes a short uncompacted Claude thread", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_SLIM.botId}/messages`, {
      text: "thanks",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_SLIM.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain(CLAUDE_SLIM.session);
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).not.toContain("fresh provider session");
    expect(prompt).not.toContain("Orbit compacted this conversation");
  }, 30_000);

  it("does not --resume a stale Claude session after Orbit compaction", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_RESUME.botId}/messages`, {
      text: "Continue with final QA",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_RESUME.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    expect(dump.argv).not.toContain(CLAUDE_RESUME.fatSession);
    expect(dump.argv).toContain("--session-id");
    const prompt = typeof dump.prompt === "string"
      ? dump.prompt
      : JSON.stringify(dump.prompt);
    expect(prompt).toContain("Orbit compacted this conversation");
    expect(prompt).toMatch(/history 0|Orbit durable context summary/);
  }, 30_000);

  it("rejects another turn while generated compaction is preparing", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start final QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const second = await api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start packaging too" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already working");
    await expect(first).resolves.toMatchObject({ status: 202 });

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
      );
      return bot?.busy === false;
    });
    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
    );
    expect(bot.messages.filter((message: { text?: string }) => message.text === "Start final QA")).toHaveLength(1);
    expect(bot.messages.some((message: { text?: string }) => message.text === "Start packaging too")).toBe(false);
  }, 30_000);

  it("rejects a 1:1 turn while the same bot is preparing room context", async () => {
    rmSync(claudeDumpPath, { force: true });
    const room = await api("POST", `/api/groups/${ROOM_FIRST.groupId}/messages`, { text: "Start room QA" });
    expect(room.status).toBe(202);
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const direct = await api("POST", `/api/bots/${ROOM_FIRST.botId}/messages`, { text: "Start direct QA too" });
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.groupId);
      return bot?.busy === false && group?.working === false;
    });

    expect(direct.status).toBe(409);
    expect(direct.body.error).toContain("already working");
    const state = (await api("GET", "/api/bots")).body;
    const bot = state.bots.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.botId);
    expect(bot.messages.some((message: { text?: string }) => message.text === "Start direct QA too")).toBe(false);
    expect(storedTaskPacket(ROOM_FIRST.roomThreadId)).toMatchObject({
      threadId: ROOM_FIRST.roomThreadId,
      botId: ROOM_FIRST.botId,
      goal: "Start room QA",
      nextAction: "Start room QA",
    });
  }, 30_000);

  it("queues a room turn while the same bot is preparing 1:1 context", async () => {
    rmSync(claudeDumpPath, { force: true });
    const direct = api("POST", `/api/bots/${DIRECT_FIRST.botId}/messages`, { text: "Start direct QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const room = await api("POST", `/api/groups/${DIRECT_FIRST.groupId}/messages`, { text: "Start room QA too" });
    const directResult = await direct;
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.groupId);
      return bot?.busy === false && group?.working === false;
    });

    expect(directResult.status).toBe(202);
    expect(room.status).toBe(202);
    const state = (await api("GET", "/api/bots")).body;
    const group = state.groups.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.groupId);
    const skipped = group.messages.find(
      (message: { tool?: { name?: string } }) => message.tool?.name?.includes("skipped this round"),
    );
    expect(skipped).toBeUndefined();
    const roomReplies = group.messages.filter(
      (message: { role?: string; kind?: string; from?: { botId?: string } }) =>
        message.role === "bot" && message.kind === "text" && message.from?.botId === DIRECT_FIRST.botId,
    );
    expect(roomReplies).toHaveLength(1);
  }, 30_000);

  it("rejects an edit claim before branching the thread", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${EDIT_CLAIM.botId}/messages`, { text: "Start guarded edit QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const before = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
    );
    const edited = await api("POST", `/api/bots/${EDIT_CLAIM.botId}/messages/m0/edit`, {
      text: "mutated while preparing",
    });

    expect(edited.status).toBe(409);
    const after = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
    );
    expect(after.activeLeafId).toBe(before.activeLeafId);
    expect(after.messages.some((message: { text?: string }) => message.text === "mutated while preparing")).toBe(false);
    await expect(first).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
      );
      return bot?.busy === false;
    });
  }, 30_000);

  it("rejects a new task claim before switching threads", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${NEW_TASK_CLAIM.botId}/messages`, { text: "Start guarded task QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const before = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
    );
    const created = await api("POST", `/api/bots/${NEW_TASK_CLAIM.botId}/tasks`, { title: "Too soon" });

    expect(created.status).toBe(409);
    const after = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
    );
    expect(after.threadId).toBe(before.threadId);
    expect(after.tasks).toHaveLength(before.tasks.length);
    await expect(first).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
      );
      return bot?.busy === false;
    });
  }, 30_000);

  it("queues a room credential continuation after a claim collision", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/groups/${SECRET_COLLISION.groupId}/messages`, {
      text: "Open the room session",
    })).status).toBe(202);
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId,
      );
      return group?.working === false;
    });
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const beforeReplies = (await api("GET", "/api/bots")).body.groups
      .find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId)
      .messages.filter((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text").length;

    const requested = await fetch(`${BASE}/api/internal/request-credential`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fromBotId: SECRET_COLLISION.botId,
        fromThreadId: SECRET_COLLISION.roomThreadId,
        credentialId: "openaiImageApiKey",
        reason: "needed for retry coverage",
      }),
    });
    expect(requested.status).toBe(201);
    const { messageId } = z.object({ messageId: z.string() }).parse(await requested.json());

    rmSync(claudeDumpPath, { force: true });
    const direct = api("POST", `/api/bots/${SECRET_COLLISION.botId}/messages`, {
      text: "Hold the direct claim",
    });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    expect((await api("POST", `/api/bots/${SECRET_COLLISION.botId}/secret-cards/${messageId}/dismiss`, {
      threadId: SECRET_COLLISION.roomThreadId,
    })).status).toBe(200);

    await expect(direct).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId);
      const replies = group.messages.filter(
        (message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text",
      );
      return bot?.busy === false && group?.working === false && replies.length > beforeReplies;
    });

    const group = (await api("GET", "/api/bots")).body.groups
      .find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId);
    expect(group.messages.some(
      (message: { tool?: { name?: string } }) => message.tool?.name?.includes("skipped this round"),
    )).toBe(false);
    const collided = group.messages.find((message: { id: string }) => message.id === messageId);
    expect(collided.secret).toMatchObject({ dismissed: true });
    expect(collided.secret.error).toBeUndefined();
  }, 40_000);

  it("flushes and injects the room task record before compaction", async () => {
    const beforeOwnerRemoval = storedTaskPacket(ROOM_TASK.roomThreadId);
    expect((await api("PATCH", `/api/groups/${ROOM_TASK.groupId}`, {
      memberIds: [ROOM_TASK_NEXT.botId, ROOM_TASK_SURVIVOR.botId],
    })).status).toBe(200);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toEqual({
      ...beforeOwnerRemoval,
      botId: ROOM_TASK_NEXT.botId,
    });

    rmSync(dumpPath, { force: true });
    expect((await api("POST", `/api/groups/${ROOM_TASK.groupId}/messages`, {
      text: `Continue after the packet owner left ${"detail ".repeat(6_000)}`,
    })).status).toBe(202);
    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === ROOM_TASK.groupId,
      );
      return group?.working === false;
    });
    const afterOwnerRemovalDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const afterOwnerRemovalTurn = afterOwnerRemovalDump.calls
      .filter((call: { method: string }) => call.method === "turn/start").at(-1);
    const afterOwnerRemovalPrompt = afterOwnerRemovalTurn.params.input[0].text;
    for (const preserved of [
      "Goal: Ship the room release",
      "active: Verify the room package",
      "Done recently: 1 total; Built the room installer",
      "file: reports/room-green.json (room checks passed)",
      "Room installer: dist/room-orbit.exe",
      "Blockers: 1 total; Awaiting release approval",
      "Next action: Continue after the packet owner left",
    ]) expect(afterOwnerRemovalPrompt).toContain(preserved);

    const beforeOwnerDeletion = storedTaskPacket(ROOM_TASK.roomThreadId);
    expect((await api("DELETE", `/api/bots/${ROOM_TASK_NEXT.botId}`)).status).toBe(200);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toEqual({
      ...beforeOwnerDeletion,
      botId: ROOM_TASK_SURVIVOR.botId,
    });

    rmSync(dumpPath, { force: true });
    expect((await api("POST", `/api/groups/${ROOM_TASK.groupId}/messages`, {
      text: `@Survivor continue after the packet owner was deleted ${"detail ".repeat(6_000)}`,
    })).status).toBe(202);
    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === ROOM_TASK.groupId,
      );
      return group?.working === false;
    });
    const afterOwnerDeletionDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const afterOwnerDeletionTurn = afterOwnerDeletionDump.calls
      .filter((call: { method: string }) => call.method === "turn/start").at(-1);
    const afterOwnerDeletionPrompt = afterOwnerDeletionTurn.params.input[0].text;
    for (const preserved of [
      "Goal: Ship the room release",
      "active: Verify the room package",
      "Done recently: 1 total; Built the room installer",
      "file: reports/room-green.json (room checks passed)",
      "Room installer: dist/room-orbit.exe",
      "Blockers: 1 total; Awaiting release approval",
      "Next action: @Survivor continue after the packet owner was deleted",
    ]) expect(afterOwnerDeletionPrompt).toContain(preserved);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toMatchObject({
      botId: ROOM_TASK_SURVIVOR.botId,
      threadId: ROOM_TASK.roomThreadId,
      flushReason: "progress",
    });
  }, 30_000);

  it("keeps the folder cleared when Settings Clear lands while a turn is preparing", async () => {
    rmSync(claudeDumpPath, { force: true });
    const send = api("POST", `/api/bots/${CLEAR_RACE.botId}/messages`, {
      text: `add tests in ${clearRaceProject}`,
    });
    // the summarizer is running: the send is persisted, the folder not yet resolved
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    const cleared = await api("PATCH", `/api/bots/${CLEAR_RACE.botId}`, { cwd: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot).not.toHaveProperty("rememberedProjectCwd");
    await expect(send).resolves.toMatchObject({ status: 202 });

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLEAR_RACE.botId,
      );
      return bot?.busy === false;
    });
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === CLEAR_RACE.botId,
    );
    expect(bot.cwd).toBeNull();
    expect(bot).not.toHaveProperty("rememberedProjectCwd");
    expect(bot.tasks[0].cwd).not.toContain("clear-race-project");
  }, 30_000);

  it("moves the continuity goal to the newest instruction", async () => {
    const first = await api("POST", `/api/bots/${GOAL_STRIP.botId}/messages`, {
      text: "Say hello in one short sentence.",
    });
    expect(first.status).toBe(202);
    expect(storedTaskPacket(GOAL_STRIP.botThreadId).goal).toBe("Say hello in one short sentence.");
    await waitFor(async () => (await botById(GOAL_STRIP.botId))?.busy === false);

    const second = await api("POST", `/api/bots/${GOAL_STRIP.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    });
    expect(second.status).toBe(202);
    // The 202 lands after the instruction is folded and before the turn settles:
    // the same in-flight window the strip renders the goal in.
    expect(storedTaskPacket(GOAL_STRIP.botThreadId).goal).toBe("Draft the outage timeline from the scanned exhibits.");
    await waitFor(async () => (await botById(GOAL_STRIP.botId))?.busy === false);

    const packet = storedTaskPacket(GOAL_STRIP.botThreadId);
    expect(packet.goal).toBe("Draft the outage timeline from the scanned exhibits.");
    // The anchor must survive the re-seed, or completion takes #112's always-blank path.
    expect(packet.instructionAction).toBe("Draft the outage timeline from the scanned exhibits.");
  }, 30_000);

  it("leaves a pre-anchor record's goal where it was", async () => {
    const sent = await api("POST", `/api/bots/${GOAL_LEGACY.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    });
    expect(sent.status).toBe(202);
    await waitFor(async () => (await botById(GOAL_LEGACY.botId))?.busy === false);

    const packet = storedTaskPacket(GOAL_LEGACY.botThreadId);
    expect(packet.goal).toBe("Ship the legacy release");
    expect(packet.instructionGoal).toBeUndefined();
    expect(packet.instructionAction).toBe("Draft the outage timeline from the scanned exhibits.");
  }, 30_000);

  it("keeps a goal the bot set through update_task_state when its text matched the seed", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${GOAL_OWNED.botId}/messages`, {
      text: "Say hello in one short sentence.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(GOAL_OWNED.botId))?.busy === false);

    // Confirming the task by echoing the seeded goal verbatim still claims it.
    const saved = await botTaskState(GOAL_OWNED.botId, GOAL_OWNED.botThreadId, {
      goal: "Say hello in one short sentence.",
      plan: [{ step: "Greet the user", status: "active" }],
    });
    expect(saved.status).toBe(200);

    expect((await api("POST", `/api/bots/${GOAL_OWNED.botId}/messages`, {
      text: "What's the status?",
    })).status).toBe(202);
    const packet = storedTaskPacket(GOAL_OWNED.botThreadId);
    expect(packet.goal).toBe("Say hello in one short sentence.");
    expect(packet.plan).toEqual([{ step: "Greet the user", status: "active" }]);
    expect(packet.instructionAction).toBe("What's the status?");
    await waitFor(async () => (await botById(GOAL_OWNED.botId))?.busy === false);
  }, 30_000);

  it("re-seeds the harness plan with the goal it was derived from", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_SEED.botId}/messages`, {
      text: "Say hello in one short sentence.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_SEED.botId))?.busy === false);
    expect(storedTaskPacket(PLAN_SEED.botThreadId).plan).toEqual([
      { step: "Say hello in one short sentence.", status: "active" },
    ]);

    expect((await api("POST", `/api/bots/${PLAN_SEED.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    })).status).toBe(202);
    // The record the model is handed must not read Goal: <new> beside Plan: active: <first>.
    const packet = storedTaskPacket(PLAN_SEED.botThreadId);
    expect(packet.goal).toBe("Draft the outage timeline from the scanned exhibits.");
    expect(packet.plan).toEqual([
      { step: "Draft the outage timeline from the scanned exhibits.", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("Draft the outage timeline from the scanned exhibits.");
    await waitFor(async () => (await botById(PLAN_SEED.botId))?.busy === false);
  }, 30_000);

  it("re-seeds the goal after a bot sends only a plan", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_ONLY.botId}/messages`, {
      text: "Say hello.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_ONLY.botId))?.busy === false);

    // update_task_state tells the bot to omit an unchanged goal, so plan-only is the normal call.
    expect((await botTaskState(PLAN_ONLY.botId, PLAN_ONLY.botThreadId, {
      plan: [
        { step: "Cut the release branch", status: "done" },
        { step: "Sign the installers", status: "active" },
      ],
    })).status).toBe(200);

    expect((await api("POST", `/api/bots/${PLAN_ONLY.botId}/messages`, {
      text: "Now draft the outage timeline.",
    })).status).toBe(202);
    const packet = storedTaskPacket(PLAN_ONLY.botThreadId);
    // A plan write claims the plan alone: the goal is still the harness's guess.
    expect(packet.goal).toBe("Now draft the outage timeline.");
    expect(packet.plan).toEqual([
      { step: "Cut the release branch", status: "done" },
      { step: "Sign the installers", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("Now draft the outage timeline.");
    await waitFor(async () => (await botById(PLAN_ONLY.botId))?.busy === false);
  }, 30_000);

  it("keeps the seeded plan step mirroring a goal the bot set", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${GOAL_ONLY.botId}/messages`, {
      text: "Ship the release.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(GOAL_ONLY.botId))?.busy === false);

    expect((await botTaskState(GOAL_ONLY.botId, GOAL_ONLY.botThreadId, {
      goal: "Ship the 2.1 release with signed installers",
    })).status).toBe(200);

    expect((await api("POST", `/api/bots/${GOAL_ONLY.botId}/messages`, {
      text: "What's the status?",
    })).status).toBe(202);
    const packet = storedTaskPacket(GOAL_ONLY.botThreadId);
    // Never Goal: Ship the 2.1 release beside Plan: active: What's the status?
    expect(packet.goal).toBe("Ship the 2.1 release with signed installers");
    expect(packet.plan).toEqual([
      { step: "Ship the 2.1 release with signed installers", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("What's the status?");
    await waitFor(async () => (await botById(GOAL_ONLY.botId))?.busy === false);
  }, 30_000);

  it("anchors a plan the harness regenerates after the bot cleared it", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Ship the release.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);

    expect((await botTaskState(PLAN_CLEARED.botId, PLAN_CLEARED.botThreadId, { plan: [] })).status).toBe(200);
    expect(storedTaskPacket(PLAN_CLEARED.botThreadId).plan).toEqual([]);

    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Draft the outage timeline.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);

    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Sign the installers.",
    })).status).toBe(202);
    // The regenerated step must carry its anchor, or it freezes while nextAction moves on.
    const packet = storedTaskPacket(PLAN_CLEARED.botThreadId);
    expect(packet.plan).toEqual([{ step: "Sign the installers.", status: "active" }]);
    expect(packet.instructionStep).toBe("Sign the installers.");
    expect(packet.instructionAction).toBe("Sign the installers.");
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);
  }, 30_000);
});
