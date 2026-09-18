import { describe, expect, it, vi } from "vitest";
import { TOOLS, callTool, readTerminalSnapshot, terminalReadGrant, terminalSnapshotText } from "./terminal-proxy.ts";

describe("terminal proxy", () => {
  it("derives distinct bot-bound read grants", () => {
    expect(terminalReadGrant("bridge-secret", "bot-1")).not.toBe(terminalReadGrant("bridge-secret", "bot-2"));
    expect(() => terminalReadGrant("bridge-secret", "bot/2")).toThrow(/grant/);
  });

  it("exposes only a read-only scoped tool", () => {
    expect(TOOLS).toHaveLength(1);
    expect(TOOLS[0]).toMatchObject({ name: "terminal_read", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(TOOLS[0].inputSchema.properties).toEqual({});
  });

  it("formats session identity, screen, and truncation metadata", () => {
    expect(terminalSnapshotText({
      sessionId: "session-1",
      generation: 2,
      cwd: "C:\\work",
      seq: 9,
      capturedAt: Date.parse("2026-09-18T05:52:00.000Z"),
      exited: false,
      screenText: "ready >",
      recentText: "previous",
      truncated: true,
    })).toContain("generation 2");
    expect(terminalSnapshotText({ state: "no-terminal" })).toContain("no active Orbit terminal");
  });

  it("returns a read error when the bridge is unavailable", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "stale terminal" }), { status: 409 });
    const result = await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale terminal");
  });

  it("does not fetch when terminal sharing is disabled", async () => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_read", fetchImpl);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not enabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the already bot-scoped bearer without exposing a master token", async () => {
    const grant = terminalReadGrant("bridge-secret", "bot-1");
    let authorization = "";
    const snapshot = await readTerminalSnapshot(
      async (_url, init) => {
        authorization = String(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ state: "no-terminal" }), { status: 200 });
      },
      { host: "http://127.0.0.1:1", token: grant, botId: "bot-1" },
    );
    expect(snapshot).toMatchObject({ state: "no-terminal" });
    expect(authorization).toBe(`Bearer ${grant}`);
  });
});
