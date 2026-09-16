import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveBotTerminalFolder } from "./terminal-cwd.ts";
import { WORKSPACES_DIR, workspaceDir } from "./workspace.ts";

describe("resolveBotTerminalFolder", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("uses an existing local project folder", () => {
    const project = join(WORKSPACES_DIR, "project-pin");
    mkdirSync(project, { recursive: true });
    expect(resolveBotTerminalFolder({ id: "bot-1", cwd: project })).toEqual({
      cwd: project,
      source: "project",
    });
  });

  it("opens folderless bots in the authoritative private workspace", () => {
    expect(resolveBotTerminalFolder({ id: "bot-folderless", cwd: null })).toEqual({
      cwd: workspaceDir("bot-folderless"),
      source: "workspace",
    });
  });

  it("refuses to silently replace a missing explicit project folder", () => {
    const missing = join(WORKSPACES_DIR, "gone");
    expect(resolveBotTerminalFolder({ id: "bot-2", cwd: missing })).toEqual({
      needsFolder: true,
      reason: "explicit-unavailable",
      explicitCwd: missing,
    });
  });

  it("treats a remote-only path as unavailable for the local terminal", () => {
    expect(resolveBotTerminalFolder({ id: "bot-3", cwd: "/home/cua/workspace" })).toEqual({
      needsFolder: true,
      reason: "explicit-unavailable",
      explicitCwd: "/home/cua/workspace",
    });
  });

  it("rejects an unknown bot", () => {
    expect(resolveBotTerminalFolder(null)).toEqual({ needsFolder: true, reason: "unknown-bot" });
  });
});
