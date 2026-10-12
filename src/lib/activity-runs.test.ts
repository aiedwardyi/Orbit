import { describe, expect, it } from "vitest";

import { activityRunVisible, activityVisibleInChat, classifyServerNotice, describeRun, describeSearch, groupActivityRuns, shownRunStep } from "./activity-runs";
import type { Message } from "@/state/store";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
/** a step with no verdict yet — `ok` absent, not `ok: undefined`, which a
 * default parameter would quietly turn back into a finished step */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });

describe("groupActivityRuns", () => {
  it("folds consecutive tool steps into one run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), tool("Edit")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), text("Now the sitemap:"), tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("folds a running step into the run, so it settles in place", () => {
    const steps = [tool("Edit"), tool("Edit"), running("Bash")];
    const items = groupActivityRuns(steps);
    expect(items.map((i) => i.kind)).toEqual(["run"]);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
    expect(items[0].kind === "run" && items[0].messages.at(-1)?.tool?.name).toBe("Bash");
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("folds ordinary failed tools into the same run as the work around them", () => {
    const items = groupActivityRuns([
      tool("Read"),
      tool("Edit"),
      tool("Bash", false),
      tool("Write"),
      tool("Write"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(5);
  });

  it("folds a storm of failed webfetch chips into one run", () => {
    const items = groupActivityRuns([
      tool("webfetch", false),
      tool("webfetch", false),
      tool("webfetch", true),
      tool("webfetch", false),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(4);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = [tool("Edit"), tool("Edit")];
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });

  it("does not attribute consecutive room steps from different bots to one sender", () => {
    const roomTool = (name: string, botId: string): Message => ({
      ...tool(name),
      from: { botId, name: botId, color: "blue" },
    });

    expect(
      groupActivityRuns([
        roomTool("Read", "alice"),
        roomTool("Edit", "alice"),
        roomTool("Write", "bob"),
        roomTool("Bash", "bob"),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });

  it("keeps local calendar-day boundaries between activity runs", () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 1).getTime();
    const stepAt = (name: string, at: number): Message => ({ ...tool(name), at });

    expect(
      groupActivityRuns([
        stepAt("Read", beforeMidnight),
        stepAt("Edit", beforeMidnight),
        stepAt("Write", afterMidnight),
        stepAt("Bash", afterMidnight),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });
});

describe("activityVisibleInChat", () => {
  it("hides plain failed tool chips while tool calls are hidden", () => {
    expect(activityVisibleInChat(tool("Bash", false), false)).toBe(false);
    expect(activityVisibleInChat(tool("Bash", false), true)).toBe(true);
  });

  it("hides failed folded runs while tool calls are hidden", () => {
    const steps = [tool("Read"), tool("Bash", false), tool("Write")];
    expect(activityRunVisible(steps, false)).toBe(false);
    expect(activityRunVisible(steps, true)).toBe(true);
  });

  it("keeps turn-level errors visible while tool calls are hidden", () => {
    expect(activityVisibleInChat(tool("error: the CLI exited", false), false)).toBe(true);
  });

  it("hides successful plain activity until tool calls are shown", () => {
    const message = tool("Read");
    expect(activityVisibleInChat(message, false)).toBe(false);
    expect(activityVisibleInChat(message, true)).toBe(true);
  });

  it("hides successful MCP agent tools until tool calls are shown", () => {
    const message = tool("mcp__agents__create_bot");
    expect(activityVisibleInChat(message, false)).toBe(false);
    expect(activityVisibleInChat(message, true)).toBe(true);
    expect(activityVisibleInChat(running("mcp__agents__create_bot"), false)).toBe(false);
  });

  it("keeps communication activity visible while tool calls are hidden", () => {
    const message: Message = {
      ...tool("Messaged @Helper"),
      comm: { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "blue" },
    };
    expect(activityVisibleInChat(message, false)).toBe(true);
  });

  it("keeps a memory-save chip visible while tool calls are hidden", () => {
    expect(activityVisibleInChat(tool("memory.save"), false)).toBe(true);
    expect(activityVisibleInChat(running("memory.save"), false)).toBe(true);
  });
});

describe("memory save stays out of a folded run", () => {
  it("does not swallow the save chip into neighboring tool steps", () => {
    const items = groupActivityRuns([tool("Edit"), tool("memory.save"), tool("Write")]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("memory.save");
  });
});

describe("describeRun", () => {
  it("heads a run with its step count and distinct edited files", () => {
    const step = (name: string, summary: string): Message => ({ ...tool(name), tool: { name, ok: true, summary } });
    expect(describeRun([step("Read", "package.json"), step("Grep", "xterm")])).toBe("2 steps");
    expect(
      describeRun([
        step("Edit", "src/a.ts +2 -1"),
        step("Edit", "src/a.ts +1 -1"),
        step("Write", "src/b.ts +40"),
        tool("Bash", false),
      ]),
    ).toBe("4 steps · 2 files edited");
    expect(describeRun([step("Edit", "a.ts +1 -0"), running("Bash")])).toBe("2 steps · 1 file edited");
  });
});

describe("terminal grouping", () => {
  it("folds reads and searches by the Claude Code verb, not the raw title", () => {
    const named = (name: string, verb: string): Message => ({ ...tool(name), tool: { name, ok: true, verb } });
    const items = groupActivityRuns([
      named("src/a.ts", "Read"),
      named("verb", "Grep"),
      named("git status", "Bash"),
      named("notes.md", "Read"),
    ], true);
    expect(items.map((item) => (item.kind === "run" ? `run:${item.messages.length}` : item.message.tool?.name))).toEqual([
      "run:2",
      "git status",
      "run:1",
    ]);
    expect(describeSearch([named("src/a.ts", "Read"), named("verb", "Grep")])).toBe("Searched for 1 pattern, read 1 file");
  });

  it("folds only read and search stretches and unfolds Bash, Edit and Write", () => {
    const items = groupActivityRuns([tool("Grep"), tool("Read"), tool("Edit"), tool("Bash"), tool("Read"), tool("Write")], true);
    expect(items.map((i) => (i.kind === "run" ? `run:${i.messages.length}` : i.message.tool?.name))).toEqual([
      "run:2",
      "Edit",
      "Bash",
      "run:1",
      "Write",
    ]);
  });

  it("groups other engines' reads and searches by their Claude Code verb", () => {
    const items = groupActivityRuns([tool("read"), tool("grep_search"), tool("bash"), tool("view_file"), tool("find")], true);
    expect(items.map((i) => (i.kind === "run" ? `run:${i.messages.length}` : i.message.tool?.name))).toEqual(["run:2", "bash", "run:2"]);
    expect(describeSearch([tool("view_file"), tool("grep")])).toBe("Searched for 1 pattern, read 1 file");
  });

  it("keeps the default fold for every other skin", () => {
    expect(groupActivityRuns([tool("Grep"), tool("Read"), tool("Edit")]).map((i) => i.kind)).toEqual(["run"]);
  });

  it("leaves error chips and memory saves out of a search run", () => {
    const items = groupActivityRuns([tool("Read"), tool("error: boom", false), tool("memory.save")], true);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "message"]);
  });
});

describe("server notices", () => {
  const named = (id: string, name: string, summary?: string, botId?: string, verb?: string): Message => {
    const step: NonNullable<Message["tool"]> = { name, ok: true };
    if (summary) step.summary = summary;
    if (verb) step.verb = verb;
    const message: Message = { id, at: 1, role: "bot", kind: "activity", tool: step };
    if (botId) message.from = { botId, name: botId, color: "blue" };
    return message;
  };

  it.each([
    ["auto-approved Bash: npm test", { kind: "approval", label: "auto", tool: "Bash", summary: "npm test" }],
    ["auto-approved Bash:git (always allowed): git status", { kind: "approval", label: "always", tool: "Bash", summary: "git status" }],
    ["auto-approved local-computer:Bash:git (always allowed): git status", { kind: "approval", label: "always", tool: "Bash", summary: "git status" }],
    ["auto-approved mcp__agents__update_task_state: {\"id\":1}", { kind: "approval", label: "auto", tool: "mcp__agents__update_task_state", summary: "{\"id\":1}" }],
    ["review approved Edit: read-only change", { kind: "approval", label: "review", tool: "Edit", summary: "read-only change" }],
    ["@Wink is waiting on your approval", { kind: "line" }],
    ["retrying \u2014 attempt 2/5 in 3s \u2014 connection reset", { kind: "line" }],
    ["Same call repeated 5× \u2014 Bash: npm test \u2014 it may be stuck", { kind: "line" }],
    ["A room member is still stopping \u2014 this message was not dispatched", { kind: "line" }],
    ["Wink is still stopping \u2014 this message was not dispatched", { kind: "line" }],
  ])("classifies %s", (name, notice) => {
    expect(classifyServerNotice(name)).toEqual(notice);
  });

  it("leaves error chips, real tools, and other server lines alone", () => {
    expect(classifyServerNotice("error: the CLI exited")).toBeNull();
    expect(classifyServerNotice("Bash")).toBeNull();
    expect(classifyServerNotice("memory.save")).toBeNull();
    expect(classifyServerNotice("Auto mode couldn't answer: nope")).toBeNull();
  });

  it("hides approval notices with the other work steps", () => {
    expect(activityVisibleInChat(named("n", "auto-approved Bash: npm test"), false)).toBe(false);
    expect(activityVisibleInChat(named("n2", "retrying \u2014 attempt 1/5 in 1s \u2014 reset"), false)).toBe(false);
  });

  it("attaches a parallel pair in order, preferring a summary prefix", () => {
    const items = groupActivityRuns([
      named("a", "Bash", "npm test"),
      named("b", "Bash", "npm test --watch"),
      named("na", "auto-approved Bash: npm test --watch"),
      named("nb", "auto-approved Bash: npm test"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind === "run" && items[0].messages.map((message) => message.id)).toEqual(["a", "b"]);
    const notices = items[0].kind === "run" ? items[0].notices : undefined;
    expect(notices?.get("b")?.map((notice) => notice.message.id)).toEqual(["na"]);
    expect(notices?.get("a")?.map((notice) => notice.message.id)).toEqual(["nb"]);
    expect(describeRun(items[0].kind === "run" ? items[0].messages : [])).toBe("2 steps");
  });

  it("gives each of two prefix-sharing steps its own exact approval", () => {
    const items = groupActivityRuns([
      named("a", "Bash", "npm test"),
      named("b", "Bash", "npm test --watch"),
      named("na", "auto-approved Bash: npm test"),
      named("nb", "auto-approved Bash: npm test --watch"),
    ]);
    const notices = items[0].kind === "run" ? items[0].notices : undefined;
    expect(notices?.get("a")?.map((notice) => notice.message.id)).toEqual(["na"]);
    expect(notices?.get("b")?.map((notice) => notice.message.id)).toEqual(["nb"]);
  });

  it("never attaches an approval to a step from an earlier turn", () => {
    const user: Message = { id: "u", at: 1, role: "user", kind: "text", text: "again" };
    const items = groupActivityRuns([
      named("old", "Bash", "npm test"),
      user,
      named("orphan", "auto-approved Bash: npm test"),
    ], true);
    expect(items.some((item) => item.kind === "message" && item.message.id === "orphan")).toBe(true);
    expect(items.some((item) => item.kind === "message" && (item.notices?.length ?? 0) > 0)).toBe(false);
  });

  it("gives the first unmatched step the notice when summaries do not match", () => {
    const items = groupActivityRuns([
      named("a", "Bash", "one"),
      named("b", "Bash", "two"),
      named("n1", "auto-approved Bash: nope"),
      named("n2", "auto-approved Bash: nada"),
    ]);
    const notices = items[0].kind === "run" ? items[0].notices : undefined;
    expect(notices?.get("a")?.map((notice) => notice.message.id)).toEqual(["n1"]);
    expect(notices?.get("b")?.map((notice) => notice.message.id)).toEqual(["n2"]);
  });

  it("keeps an approval on the same bot and the same tool", () => {
    const items = groupActivityRuns([
      named("edit", "Edit", "a.ts", "alice"),
      named("alice", "Bash", "pwd", "alice"),
      named("bob-edit", "Edit", "b.ts", "bob"),
      named("bob", "Bash", "pwd", "bob"),
      named("notice", "auto-approved Bash: pwd", undefined, "bob"),
    ]);
    const bob = items.find((item) => item.kind === "run" && item.messages.some((message) => message.id === "bob"));
    const alice = items.find((item) => item.kind === "run" && item.messages.some((message) => message.id === "alice"));
    expect(bob?.kind === "run" && bob.notices?.get("bob")?.map((notice) => notice.label)).toEqual(["auto"]);
    expect(bob?.kind === "run" && bob.messages.some((message) => message.id === "notice")).toBe(false);
    expect(alice?.kind === "run" && (alice.notices?.size ?? 0)).toBe(0);
  });

  it("matches an always-allow key and a review to the step verb", () => {
    const items = groupActivityRuns([
      named("bash", "git status", "git status", undefined, "Bash"),
      named("always", "auto-approved Bash:git (always allowed): git status"),
      named("edit", "src/a.ts", "src/a.ts", undefined, "Edit"),
      named("review", "review approved Edit: read-only"),
    ], true);
    const bash = items.find((item) => item.kind === "message" && item.message.id === "bash");
    const edit = items.find((item) => item.kind === "message" && item.message.id === "edit");
    expect(bash?.kind === "message" && bash.notices?.map((notice) => notice.label)).toEqual(["always"]);
    expect(edit?.kind === "message" && edit.notices?.map((notice) => notice.label)).toEqual(["review"]);
    expect(items.some((item) => item.kind === "message" && item.message.id === "always")).toBe(false);
  });

  it("keeps an approval with no step as its own row", () => {
    const items = groupActivityRuns([
      named("read", "Read"),
      named("orphan", "auto-approved Bash: curl -X POST /talk"),
      named("edit", "Edit"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind === "run" && items[0].messages.map((message) => message.tool?.name)).toEqual([
      "Read",
      "auto-approved Bash: curl -X POST /talk",
      "Edit",
    ]);
    expect(describeRun(items[0].kind === "run" ? items[0].messages : [])).toBe("2 steps");
    const orphan = items[0].kind === "run" ? items[0].messages[1] : named("x", "Bash");
    expect(shownRunStep(orphan, { terminal: false, showActivities: true, findId: null })).toBe(false);
    expect(shownRunStep(orphan, { terminal: false, showActivities: false, findId: "orphan" })).toBe(true);
    expect(shownRunStep(items[0].kind === "run" ? items[0].messages[0] : orphan, { terminal: false, showActivities: false, findId: "orphan" })).toBe(false);
  });
});

describe("describeSearch", () => {
  it("names an empty search instead of rendering an empty button", () => {
    expect(describeSearch([])).toBe("Searched");
  });

  it("counts patterns and files the way Claude Code does", () => {
    expect(describeSearch([tool("Grep"), tool("Read"), tool("Read")])).toBe("Searched for 1 pattern, read 2 files");
    expect(describeSearch([tool("Glob"), tool("Grep")])).toBe("Searched for 2 patterns");
    expect(describeSearch([tool("Read")])).toBe("Read 1 file");
  });
});
