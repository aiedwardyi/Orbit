import { describe, expect, it } from "vitest";
import { termVerb } from "./tool-verb.ts";

describe("termVerb", () => {
  it.each([
    ["Edit", "Update"],
    ["MultiEdit", "Update"],
    ["shell", "Bash"],
    ["commandExecution", "Bash"],
    ["web_search", "Web Search"],
    ["WebFetch", "Fetch"],
    ["Agent", "Task"],
    ["view_file", "Read"],
    ["find_by_name", "Glob"],
    ["read_url_content", "Fetch"],
  ])("maps %s to %s", (name, verb) => {
    expect(termVerb(name)).toBe(verb);
  });

  it("keeps names it does not know", () => {
    expect(termVerb("Bash")).toBe("Bash");
    expect(termVerb("browser_click")).toBe("browser_click");
  });

  it("reads an MCP call as server, tool, and MCP", () => {
    expect(termVerb("mcp__agents__update_task_state")).toBe("agents - update_task_state (MCP)");
  });
});
