import { describe, expect, it } from "vitest";

import { TERM_STEP_WORD, termBlock, termElapsed, termHeaderArgs, termMeter, termResultLine, termStepAria, termUpdatedLine, termVerb } from "./terminal-skin";
import { en, ko } from "./i18n-catalog";
import { applyLocale, t } from "./i18n";

describe("termVerb", () => {
  it("maps tool names to Claude Code verbs across engines", () => {
    expect(termVerb("Edit")).toBe("Update");
    expect(termVerb("MultiEdit")).toBe("Update");
    expect(termVerb("edit")).toBe("Update");
    expect(termVerb("shell")).toBe("Bash");
    expect(termVerb("web_search")).toBe("Web Search");
    expect(termVerb("WebFetch")).toBe("Fetch");
    expect(termVerb("Agent")).toBe("Task");
  });

  it.each([
    ["commandExecution", "Bash"],
    ["fileChange", "Update"],
    ["webSearch", "Web Search"],
    ["bash", "Bash"],
    ["read", "Read"],
    ["edit", "Update"],
    ["write", "Write"],
    ["grep", "Grep"],
    ["find", "Glob"],
    ["ls", "List"],
    ["run_command", "Bash"],
    ["view_file", "Read"],
    ["write_to_file", "Write"],
    ["replace_file_content", "Update"],
    ["multi_replace_file_content", "Update"],
    ["grep_search", "Grep"],
    ["find_by_name", "Glob"],
    ["list_dir", "List"],
    ["search_web", "Web Search"],
    ["read_url_content", "Fetch"],
  ])("maps the driver tool name %s to %s", (name, verb) => {
    expect(termVerb(name)).toBe(verb);
  });

  it("keeps names it does not know", () => {
    expect(termVerb("Bash")).toBe("Bash");
    expect(termVerb("browser_click")).toBe("browser_click");
  });

  it("reads an MCP call as server, tool, and MCP", () => {
    expect(termVerb("mcp__agents__update_task_state")).toBe("agents - update_task_state (MCP)");
    expect(termVerb("mcp__computer__click")).toBe("computer - click (MCP)");
  });
});

describe("termResultLine", () => {
  it("settles into Done or Failed with the duration", () => {
    expect(termResultLine("Done", 1200)).toBe("Done (1.2s)");
    expect(termResultLine("Failed", 400)).toBe("Failed (0.4s)");
    expect(termResultLine("Done", 62_000)).toBe("Done (1m 2s)");
  });

  it("is never empty without a duration", () => {
    expect(termResultLine("Done", undefined)).toBe("Done");
    expect(termResultLine("Failed", undefined)).toBe("Failed");
    expect(termResultLine("Running…", 3000)).toBe("Running… (3.0s)");
  });

  it("takes its words from the catalogs", () => {
    expect(Object.values(TERM_STEP_WORD).map((key) => en[key])).toEqual(["Running…", "Done", "Failed"]);
    expect(Object.values(TERM_STEP_WORD).map((key) => ko[key])).toEqual(["실행 중…", "완료", "실패"]);
  });
});

describe("termHeaderArgs", () => {
  it("heads Bash, Update and Write with the captured command or path", () => {
    expect(termHeaderArgs("Bash", "git st", { input: "git status" })).toBe("git status");
    expect(termHeaderArgs("Update", "a.ts +1 -1", { input: "a.ts" })).toBe("a.ts");
    expect(termHeaderArgs("Write", "a.ts", undefined)).toBe("a.ts");
  });

  it("keeps the summary for other tools", () => {
    expect(termHeaderArgs("Fetch", "example.com", { input: '{"url":"https://example.com"}' })).toBe("example.com");
    expect(termHeaderArgs("mcp_tool", undefined, { input: '{"q":1}' })).toBe('{"q":1}');
  });

  it("falls back to the step name when a verb has no captured input", () => {
    expect(termHeaderArgs("Bash", undefined, undefined, "git status")).toBe("git status");
    expect(termHeaderArgs("Update", undefined, undefined, "src/a.ts")).toBe("src/a.ts");
    expect(termHeaderArgs("Bash", "git st", { input: "git status" }, "git status")).toBe("git status");
    expect(termHeaderArgs("Bash", undefined, undefined)).toBeUndefined();
  });
});

describe("termBlock", () => {
  it("keeps the Done line without output", () => {
    expect(termBlock(undefined, false)).toBeNull();
    expect(termBlock({ input: "a.ts" }, false)).toBeNull();
    expect(termBlock({ input: "ls", output: [] }, true)).toBeNull();
  });

  it("hides secret output", () => {
    expect(termBlock({ input: "env", outputHidden: true }, false)).toEqual({ kind: "hidden" });
  });

  it("counts a whole diff and tones its rows", () => {
    expect(termBlock({ input: "a.ts", diff: ["-a", "+b", "+c"] }, false)).toEqual({
      kind: "lines",
      rows: [{ text: "- a", tone: "remove" }, { text: "+ b", tone: "add" }, { text: "+ c", tone: "add" }],
      changes: { additions: 2, removals: 1 },
    });
  });

  it("counts nothing when lines were cut", () => {
    expect(termBlock({ input: "a.ts", diff: ["+a"], more: 3 }, false)).toEqual({ kind: "lines", rows: [{ text: "+ a", tone: "add" }], more: 3 });
    expect(termBlock({ output: ["+a"] }, false)).toEqual({ kind: "lines", rows: [{ text: "+a" }] });
  });

  it("draws a failure's output", () => {
    expect(termBlock({ input: "x", output: ["boom"], more: 2 }, true)).toEqual({ kind: "lines", rows: [{ text: "boom" }], more: 2 });
  });
});

describe("termUpdatedLine", () => {
  it("names only the changes that happened", () => {
    applyLocale("en");
    expect(termUpdatedLine(t, "a.ts", { additions: 2, removals: 1 })).toBe("Updated a.ts with 2 additions and 1 removal");
    expect(termUpdatedLine(t, "a.ts", { additions: 1, removals: 0 })).toBe("Updated a.ts with 1 addition");
    expect(termUpdatedLine(t, "a.ts", { additions: 0, removals: 3 })).toBe("Updated a.ts with 3 removals");
    expect(termUpdatedLine(t, "a.ts", { additions: 0, removals: 0 })).toBeUndefined();
    applyLocale("ko");
    expect(termUpdatedLine(t, "a.ts", { additions: 2, removals: 1 })).toBe("a.ts 수정: 2줄 추가, 1줄 삭제");
    applyLocale("en");
  });
});

describe("termStepAria", () => {
  it("speaks state and seconds", () => {
    expect(termStepAria("done", 1234)).toEqual({ key: "term.step.ariaDone", seconds: 1.2 });
    expect(termStepAria("failed", undefined)).toEqual({ key: "term.step.ariaFailedBare" });
    expect(termStepAria("running", 500)).toEqual({ key: "term.step.ariaRunning" });
  });
});

describe("termElapsed", () => {
  it("prints the working line's clock", () => {
    expect(termElapsed(12_400)).toBe("12s");
    expect(termElapsed(158_000)).toBe("2m 38s");
    expect(termElapsed(-5)).toBe("0s");
  });
});

describe("termMeter", () => {
  const now = 1_000_000;
  const window = { id: "five_hour", usedPercent: 71, resetsAt: now + 60_000, windowMinutes: 300 };

  it("shows what's left by default", () => {
    expect(termMeter(window, now, "remaining")).toEqual({ id: "five_hour", kind: "session", percent: 29, bar: "▰▱▱▱▱" });
  });

  it("follows the used mode", () => {
    expect(termMeter(window, now, "used")).toMatchObject({ percent: 71, bar: "▰▰▰▰▱" });
  });

  it("empties the bar once the window has reset", () => {
    expect(termMeter({ ...window, resetsAt: now - 1 }, now, "remaining")).toMatchObject({ percent: null, bar: "▱▱▱▱▱" });
  });
});
