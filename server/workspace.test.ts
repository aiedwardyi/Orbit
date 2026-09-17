// Workspace + file memory contract: the workspace is created idempotently,
// MEMORY.md loads under a hard budget, and an empty file stays out of the
// first-turn prompt.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ensureWorkspace,
  isMemoryTopicName,
  listMemoryTopics,
  loadMemory,
  memorySystemPrompt,
  readMemoryFile,
  readMemoryTopic,
  supportsWorkspaceFiles,
  workspaceDir,
  writeMemoryFile,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
  MEMORY_SEED,
  WORKSPACES_DIR,
} from "./workspace.ts";

const BOT = "bot-workspace-test";

describe("workspace", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("creates the workspace with a memory dir and no seed MEMORY.md, idempotently", () => {
    const dir = ensureWorkspace(BOT);
    expect(dir).toBe(workspaceDir(BOT));
    expect(existsSync(join(dir, "memory"))).toBe(true);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);

    // a second ensure must not clobber what the bot wrote
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- the user prefers pnpm\n");
    ensureWorkspace(BOT);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("prefers pnpm");
  });

  it("treats a missing or seed-only MEMORY.md as empty", () => {
    expect(loadMemory(BOT)).toBeNull();
    ensureWorkspace(BOT);
    expect(loadMemory(BOT)).toBeNull();
    writeFileSync(join(workspaceDir(BOT), "MEMORY.md"), MEMORY_SEED);
    expect(loadMemory(BOT)).toBeNull();
  });

  it("loads written memory whole when under budget", () => {
    const dir = ensureWorkspace(BOT);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- fact one\n- fact two\n");
    const memory = loadMemory(BOT);
    expect(memory?.text).toContain("fact two");
    expect(memory?.truncated).toBe(false);
  });

  it("cuts at the line budget and flags the truncation", () => {
    const dir = ensureWorkspace(BOT);
    const lines = Array.from({ length: MEMORY_MAX_LINES + 50 }, (_, i) => `- fact ${i}`);
    writeFileSync(join(dir, "MEMORY.md"), lines.join("\n"));
    const memory = loadMemory(BOT);
    expect(memory?.truncated).toBe(true);
    expect(memory?.text.split("\n")).toHaveLength(MEMORY_MAX_LINES);
    expect(memory?.text).toContain(`- fact ${MEMORY_MAX_LINES - 1}`);
    expect(memory?.text).not.toContain(`- fact ${MEMORY_MAX_LINES}\n`);
  });

  it("cuts at the byte budget without leaving a torn multi-byte character", () => {
    const dir = ensureWorkspace(BOT);
    // few lines, many bytes — multi-byte chars so a naive slice would tear one
    writeFileSync(join(dir, "MEMORY.md"), `# Memory\n${"é".repeat(MEMORY_MAX_BYTES)}`);
    const memory = loadMemory(BOT);
    expect(memory?.truncated).toBe(true);
    expect(Buffer.byteLength(memory!.text, "utf8")).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(memory!.text).not.toContain("�");
  });

  it("readMemoryFile hands back the WHOLE file, flagging what the budget would cut", () => {
    // missing workspace and seed-only both read as empty — an editor should
    // open blank, not on the seed's instructions
    expect(readMemoryFile(BOT)).toEqual({ text: "", truncated: false });
    ensureWorkspace(BOT);
    expect(readMemoryFile(BOT)).toEqual({ text: "", truncated: false });
    writeFileSync(join(workspaceDir(BOT), "MEMORY.md"), MEMORY_SEED);
    expect(readMemoryFile(BOT)).toEqual({ text: "", truncated: false });

    const dir = workspaceDir(BOT);
    const lines = Array.from({ length: MEMORY_MAX_LINES + 50 }, (_, i) => `- fact ${i}`);
    writeFileSync(join(dir, "MEMORY.md"), lines.join("\n"));
    const file = readMemoryFile(BOT);
    // over budget: loadMemory cuts, the editor view must not
    expect(file.truncated).toBe(true);
    expect(file.text.split("\n")).toHaveLength(MEMORY_MAX_LINES + 50);

    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- one fact\n");
    expect(readMemoryFile(BOT)).toEqual({ text: "# Memory\n- one fact\n", truncated: false });
  });

  it("writeMemoryFile round-trips without needing the workspace to exist first", () => {
    writeMemoryFile(BOT, "# Memory\n- written from the panel\n");
    expect(readMemoryFile(BOT).text).toContain("written from the panel");
    // and the write is the same file every turn loads
    expect(loadMemory(BOT)?.text).toContain("written from the panel");
  });

  it("accepts plain single-segment topic names and nothing else", () => {
    for (const good of ["deploys.md", "a.md", "my notes.md", "v1.2-rc.md", "under_score.md"]) {
      expect(isMemoryTopicName(good), good).toBe(true);
    }
    for (const bad of [
      "",
      "no-extension",
      "notes.MD",
      ".hidden.md",
      "..md",
      "../x.md",
      "..%2F..%2Fsecret.md",
      "a/b.md",
      "a\\b.md",
      ".md",
      `${"a".repeat(300)}.md`,
    ]) {
      expect(isMemoryTopicName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("lists only valid topic files, with sizes, ignoring everything else", () => {
    const dir = ensureWorkspace(BOT);
    writeFileSync(join(dir, "memory", "deploys.md"), "12345678");
    writeFileSync(join(dir, "memory", "auth.md"), "x");
    writeFileSync(join(dir, "memory", ".draft.md"), "hidden");
    writeFileSync(join(dir, "memory", "notes.txt"), "wrong extension");
    expect(listMemoryTopics(BOT)).toEqual([
      { name: "auth.md", bytes: 1 },
      { name: "deploys.md", bytes: 8 },
    ]);
    // a bot with no workspace has no topics, not an error
    expect(listMemoryTopics("never-ran")).toEqual([]);
  });

  it("readMemoryTopic refuses traversal names even when the target exists", () => {
    const dir = ensureWorkspace(BOT);
    writeFileSync(join(dir, "memory", "deploys.md"), "- deploy = pnpm ship\n");
    expect(readMemoryTopic(BOT, "deploys.md")).toContain("pnpm ship");
    expect(readMemoryTopic(BOT, "missing.md")).toBeNull();
    // plant real files where a traversal would land: the workspace's own
    // MEMORY.md (one level up) and a sibling outside the workspace
    writeFileSync(join(dir, "MEMORY.md"), "SECRET-MEMORY");
    writeFileSync(join(WORKSPACES_DIR, "secret.md"), "SECRET-SIBLING");
    expect(readMemoryTopic(BOT, "../MEMORY.md")).toBeNull();
    expect(readMemoryTopic(BOT, "../../secret.md")).toBeNull();
    expect(readMemoryTopic(BOT, "..\\MEMORY.md")).toBeNull();
  });

  it("does not inject empty MEMORY.md into the first-turn prompt", () => {
    ensureWorkspace(BOT);
    expect(memorySystemPrompt(BOT)).toBe("");
    expect(memorySystemPrompt(BOT)).not.toMatch(/MEMORY\.md/);
    writeFileSync(join(workspaceDir(BOT), "MEMORY.md"), MEMORY_SEED);
    expect(memorySystemPrompt(BOT)).toBe("");
  });

  it("embeds MEMORY.md once the bot has written notes", () => {
    const dir = ensureWorkspace(BOT);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- deploy = `railway up`\n");
    const withMemory = memorySystemPrompt(BOT);
    expect(withMemory).toContain("Your memory (MEMORY.md):");
    expect(withMemory).toContain("railway up");
  });

  it("only sends file-backed memory to engines with local workspace files", () => {
    expect(supportsWorkspaceFiles("claudeAgent")).toBe(true);
    expect(supportsWorkspaceFiles("geminiAgent")).toBe(true);
    for (const driverKind of ["grok", "openai-compat", "minimax", "boxAgent"]) {
      expect(supportsWorkspaceFiles(driverKind), driverKind).toBe(false);
    }
  });
});
