import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { MEMORY_SAVE_TOOL, memorySaveSummary, peekMemory, rememberMemoryWrite, resetMemorySnapshots } from "./memory-save.ts";
import { writeMemoryFile } from "./workspace.ts";

describe("memorySaveSummary", () => {
  it("returns the newest added bullet without the marker", () => {
    expect(
      memorySaveSummary("# Memory\n", "# Memory\n- prefers pnpm\n- bullet-style standups\n"),
    ).toBe("bullet-style standups");
  });

  it("returns null when nothing was added", () => {
    expect(memorySaveSummary("# Memory\n- prefers pnpm\n", "# Memory\n- prefers pnpm\n")).toBeNull();
    expect(memorySaveSummary("# Memory\n- prefers pnpm\n", "# Memory\n")).toBeNull();
  });

  it("skips headings and caps one line", () => {
    const long = "x".repeat(120);
    expect(memorySaveSummary("", `# Memory\n## Notes\n- ${long}\n`)).toBe("x".repeat(80));
  });
});

describe("rememberMemoryWrite", () => {
  const botId = "bot-memory-save";

  beforeEach(() => {
    resetMemorySnapshots();
  });

  it("is silent until MEMORY.md actually gains a note", () => {
    peekMemory(botId);
    expect(rememberMemoryWrite(botId)).toBeNull();
    writeMemoryFile(botId, "# Memory\n- bullet-style standups\n");
    expect(rememberMemoryWrite(botId)).toBe("bullet-style standups");
    expect(rememberMemoryWrite(botId)).toBeNull();
  });
});

describe("memory save wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(here, "index.ts"), "utf8");

  it("exports the chip name the client looks for", () => {
    expect(MEMORY_SAVE_TOOL).toBe("memory.save");
  });

  it("peeks on tool start and records a chip after a successful tool", () => {
    expect(index).toContain("peekMemory(");
    expect(index).toContain("rememberMemoryWrite(");
    expect(index).toContain("MEMORY_SAVE_TOOL");
  });

  it("tells the bot to take chat corrections instead of sending the user to settings", () => {
    const workspace = readFileSync(join(here, "workspace.ts"), "utf8");
    expect(workspace).toMatch(/corrects a memory note/i);
  });
});
