import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { activityRunVisible, activityVisibleInChat, classifyServerNotice, describeRun, describeSearch, groupActivityRuns, isServerLine, itemMatchesFind, localizeServerLine, SERVER_LINES, shownRunStep } from "./activity-runs";
import { translate, type Translate } from "@/lib/i18n";
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

describe("consecutive memory saves", () => {
  const save = (botId?: string, when?: number): Message => {
    const message = tool("memory.save");
    if (when !== undefined) message.at = when;
    if (botId) message.from = { botId, name: botId, color: "blue" };
    return message;
  };
  type Items = ReturnType<typeof groupActivityRuns>;
  const kinds = (items: Items) => items.map((item) => item.kind);
  const memory = (item: Items[number]) => (item.kind === "memory" ? item.messages : []);

  it("folds a run of two or more into one item", () => {
    const saves = [save(), save(), save()];
    const items = groupActivityRuns([text("hi"), ...saves, text("done")]);
    expect(kinds(items)).toEqual(["message", "memory", "message"]);
    expect(memory(items[1])).toEqual(saves);
    expect(items[1].kind === "memory" && items[1].id).toBe(`memory:${saves[0].id}`);
  });

  it("leaves a lone save as an ordinary message", () => {
    expect(kinds(groupActivityRuns([text("hi"), save(), text("done")]))).toEqual(["message", "message", "message"]);
  });

  it("is not broken by rows the chat hides", () => {
    const [a, b, c] = [save(), save(), save()];
    const read = tool("Read");
    const hidden = (message: Message) => message.id === read.id || message.tool?.name === "Edit";
    const items = groupActivityRuns([a, read, b, tool("Edit"), tool("Edit"), c], false, (message) => !hidden(message));
    expect(items.filter((item) => item.kind === "memory").map(memory)).toEqual([[a, b, c]]);
    expect(items.filter((item) => item.kind === "message").map((item) => item.kind === "message" && item.message.id)).toEqual([read.id]);
    expect(items).toHaveLength(3);
  });

  it("is broken by anything the chat shows between two saves", () => {
    const comm = { ...tool("Message to @Atlas"), comm: { groupId: "pair", withBotId: "b2", withName: "Atlas", withColor: "pink" as const, peer: "message" as const } };
    const breaks: Message[][] = [
      [text("Noted.")],
      [{ ...text("hi"), role: "user" }],
      [tool("Read"), tool("Read")],
      [comm],
      [tool("error: boom", false)],
    ];
    for (const between of breaks) {
      expect(kinds(groupActivityRuns([save(), ...between, save()]))).not.toContain("memory");
    }
    const items = groupActivityRuns([save(), save(), text("Noted."), save(), save(), save()]);
    expect(items.map((item) => (item.kind === "memory" ? `memory:${item.messages.length}` : item.kind))).toEqual(["memory:2", "message", "memory:3"]);
  });

  it("never folds a failed save, which splits the run as its own row", () => {
    const failed = tool("memory.save", false);
    const items = groupActivityRuns([save(), save(), failed, save(), save()]);
    expect(items.map((item) => (item.kind === "memory" ? `memory:${item.messages.length}` : item.kind))).toEqual(["memory:2", "message", "memory:2"]);
    expect(items[1].kind === "message" && items[1].message).toBe(failed);
  });

  it("does not fold saves the chat shows as nothing", () => {
    expect(kinds(groupActivityRuns([save(), save(), save()], false, () => false))).toEqual(["message", "message", "message"]);
  });

  it("starts a new run for another bot or another day", () => {
    const day = (n: number) => new Date(2026, 0, n, 12).getTime();
    expect(kinds(groupActivityRuns([save("a"), save("a"), save("b"), save("b")]))).toEqual(["memory", "memory"]);
    expect(kinds(groupActivityRuns([save("a", day(1)), save("a", day(1)), save("a", day(2)), save("a", day(2))]))).toEqual(["memory", "memory"]);
  });

  it("keeps saves out of a tool run", () => {
    expect(kinds(groupActivityRuns([tool("Edit"), tool("Edit"), save(), save(), tool("Write"), tool("Write")]))).toEqual(["run", "memory", "run"]);
  });

  it("matches a find hit on any note in the run", () => {
    const [a, b] = [save(), save()];
    const [item] = groupActivityRuns([a, b]);
    expect(itemMatchesFind(item, b.id)).toBe(true);
    expect(itemMatchesFind(item, "other")).toBe(false);
  });
});

describe("describeRun", () => {
  it("heads a run with its step count and distinct edited files", () => {
    const step = (name: string, summary: string): Message => ({ ...tool(name), tool: { name, ok: true, summary } });
    expect(describeRun([step("Grep", "xterm")])).toBe("1 step");
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
    expect(items.map((item) => (item.kind === "message" ? item.message.tool?.name : `run:${item.messages.length}`))).toEqual([
      "run:2",
      "git status",
      "run:1",
    ]);
    expect(describeSearch([named("src/a.ts", "Read"), named("verb", "Grep")])).toBe("Searched for 1 pattern, read 1 file");
  });

  it("folds only read and search stretches and unfolds Bash, Edit and Write", () => {
    const items = groupActivityRuns([tool("Grep"), tool("Read"), tool("Edit"), tool("Bash"), tool("Read"), tool("Write")], true);
    expect(items.map((i) => (i.kind === "message" ? i.message.tool?.name : `run:${i.messages.length}`))).toEqual([
      "run:2",
      "Edit",
      "Bash",
      "run:1",
      "Write",
    ]);
  });

  it("groups other engines' reads and searches by their Claude Code verb", () => {
    const items = groupActivityRuns([tool("read"), tool("grep_search"), tool("bash"), tool("view_file"), tool("find")], true);
    expect(items.map((i) => (i.kind === "message" ? i.message.tool?.name : `run:${i.messages.length}`))).toEqual(["run:2", "bash", "run:2"]);
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

describe("localizeServerLine", () => {
  const en: Translate = (key, vars) => translate("en", key, vars);
  const ko: Translate = (key, vars) => translate("ko", key, vars);
  const samples: [string, string][] = [
    ["Message to @Atlas", "@Atlas에게 보낸 메시지"],
    ["Message from @Atlas", "@Atlas에게서 온 메시지"],
    ["Reply from @Atlas", "@Atlas의 답장"],
    ["Queued for @Atlas, sends when this reply ends", "@Atlas에게 대기 중, 이 응답이 끝나면 전송됩니다"],
    ["Queued for @Atlas, sends when this reply ends: check the build", "@Atlas에게 대기 중, 이 응답이 끝나면 전송됩니다: check the build"],
    ["error: delegation failed \u2014 Atlas is offline", "오류: 위임 실패 - Atlas is offline"],
    ["error: delegation to @Atlas could not start \u2014 spawn failed", "오류: @Atlas에게 한 위임을 시작하지 못했습니다 - spawn failed"],
    ["Delegation to @Atlas dropped - the turn did not finish", "@Atlas에게 한 위임 취소됨 - 턴이 끝나지 않았습니다"],
    ["1 queued delegation dropped \u2014 the turn did not finish", "대기 중이던 위임 1건 취소됨 - 턴이 끝나지 않았습니다"],
    ["3 queued delegations dropped \u2014 the turn did not finish", "대기 중이던 위임 3건 취소됨 - 턴이 끝나지 않았습니다"],
    ["Delegation to @Atlas waiting \u2014 they're busy (retry 2/5 when they finish)", "@Atlas에게 한 위임 대기 중 - 상대가 작업 중입니다 (끝나면 2/5번째 재시도)"],
    ["Delegation to @Atlas canceled \u2014 still busy after 5 retries", "@Atlas에게 한 위임 취소됨 - 5회 재시도 후에도 계속 작업 중"],
    ["Delegation to @Atlas denied by user", "@Atlas에게 한 위임을 사용자가 거부했습니다"],
    ["Delivered to @Atlas", "@Atlas에게 전달됨"],
    ["@Atlas replied", "@Atlas 답장 도착"],
    ["Atlas answered Edward in its own chat instead", "Atlas - 대신 자기 채팅에서 Edward에게 답변함"],
    ["Delegated turn did not finish", "위임한 턴이 끝나지 않았습니다"],
    ["Delegated turn completed", "위임한 턴이 완료되었습니다"],
    ["Delegated turn stalled and was stopped", "위임한 턴이 멈춰서 중단되었습니다"],
    ["Delegated turn could not start \u2014 spawn failed", "위임한 턴을 시작하지 못했습니다 - spawn failed"],
  ];

  it.each(samples)("maps %s into Korean", (line, korean) => {
    expect(localizeServerLine(line, ko)).toBe(korean);
  });

  it.each(samples)("leaves %s as written in English", (line) => {
    expect(localizeServerLine(line, en)).toBe(line);
  });

  it("maps a line without its error prefix, as the error row shows it", () => {
    for (const line of ["Agentic Mode paused: two tries made no progress", "Keep going paused: two tries in a row made no progress on the approved steps"]) {
      expect(localizeServerLine(line, en)).toBe("Agentic Mode paused: two tries made no progress");
      expect(localizeServerLine(line, ko)).toBe("에이전트 모드 일시 중지됨: 두 번 시도에 진전 없음");
    }
    expect(localizeServerLine("delegation failed \u2014 Atlas is offline", ko)).toBe("위임 실패 - Atlas is offline");
  });

  it("passes free text through untouched, even when it looks like a placeholder or a replacement pattern", () => {
    const why = "bad $& $$ {name} {why} \u2014 “quoted”\n2nd line";
    expect(localizeServerLine(`error: delegation failed \u2014 ${why}`, en)).toBe(`error: delegation failed \u2014 ${why}`);
    expect(localizeServerLine(`error: delegation failed \u2014 ${why}`, ko)).toBe(`오류: 위임 실패 - ${why}`);
    expect(localizeServerLine(`Queued for @Atlas, sends when this reply ends: ${why}`, ko)).toBe(`@Atlas에게 대기 중, 이 응답이 끝나면 전송됩니다: ${why}`);
  });

  it("swaps the error prefix for the app language on a mapped line only", () => {
    const line = "error: delegation failed \u2014 Atlas is offline";
    expect(localizeServerLine(line, en).startsWith("error: ")).toBe(true);
    expect(localizeServerLine(line, ko).startsWith("오류: ")).toBe(true);
    expect(localizeServerLine("error: the CLI exited", ko)).toBe("error: the CLI exited");
    expect(localizeServerLine("error: the CLI exited", en)).toBe("error: the CLI exited");
  });

  it("never shows the id of a deleted bot", () => {
    const stored = "error: delegation to b7 failed \u2014 no such bot";
    expect(localizeServerLine(stored, en)).toBe("error: delegation failed - that bot was deleted");
    expect(localizeServerLine(stored, ko)).toBe("오류: 위임 실패 - 삭제된 봇입니다");
    expect(localizeServerLine(stored.slice(7), en)).toBe("delegation failed - that bot was deleted");
    expect(localizeServerLine(stored.slice(7), ko)).toBe("위임 실패 - 삭제된 봇입니다");
  });

  it("keeps the bot name whole when it holds punctuation", () => {
    expect(localizeServerLine("Delivered to @R2-D2 (v2)", ko)).toBe("@R2-D2 (v2)에게 전달됨");
  });

  it("passes unknown lines through", () => {
    for (const line of ["Bash", "memory.save", "error: the CLI exited", "Message to Atlas", "Delivered to Atlas", "auto-approved Bash: npm test"]) {
      expect(localizeServerLine(line, ko)).toBe(line);
    }
  });

  it("does not change how a line is classified or grouped", () => {
    const line = "Delegation to @Atlas denied by user";
    expect(classifyServerNotice(line)).toBeNull();
    expect(groupActivityRuns([tool(line, false), tool(line, false)])[0].kind).toBe("run");
  });
});

describe("isServerLine", () => {
  it("knows the waiting, queued and error lines, with or without the error prefix", () => {
    for (const line of [
      "Delegation to @Atlas waiting \u2014 they're busy (retry 2/5 when they finish)",
      "Queued for @Atlas, sends when this reply ends: check the build",
      "error: delegation failed \u2014 Atlas is offline",
      "delegation failed \u2014 Atlas is offline",
    ]) expect(isServerLine(line), line).toBe(true);
  });

  it("leaves tool commands and unknown lines out", () => {
    for (const line of ["Bash: npm test", "Bash", "memory.save", "error: the CLI exited", "Delivered to Atlas", "auto-approved Bash: npm test"]) {
      expect(isServerLine(line), line).toBe(false);
    }
  });
});

describe("server handoff lines", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (file: string) => readFileSync(join(here, "../../server", file), "utf8");

  it("still writes the English each pattern reads", () => {
    for (const line of SERVER_LINES) {
      const text = source(line.file);
      for (const needle of line.needles) expect(text.includes(needle), `${line.file}: ${needle}`).toBe(true);
    }
  });

  it("fails when the server rewords a line", () => {
    const reworded = source("delegations.ts").replaceAll("Delivered to @", "Handed to @");
    expect(SERVER_LINES.filter((line) => line.file === "delegations.ts" && line.needles.some((needle) => !reworded.includes(needle))).map((line) => line.re.source)).toEqual(["^Delivered to @(.+)$"]);
  });
});
