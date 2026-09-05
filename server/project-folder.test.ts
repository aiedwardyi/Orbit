import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyResolvedProjectFolder,
  projectPathsFromRecords,
  resolveProjectFolder,
  userProjectTexts,
} from "./project-folder.ts";

let dirs: string[] = [];

function folder(name?: string, files: Record<string, string> = {}): string {
  const dir = name
    ? (() => {
        const parent = mkdtempSync(join(tmpdir(), "omb-proj-"));
        dirs.push(parent);
        const path = join(parent, name);
        mkdirSync(path);
        return path;
      })()
    : mkdtempSync(join(tmpdir(), "omb-proj-"));
  if (!name) dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("resolveProjectFolder", () => {
  it("keeps an explicit pin over a named path, a scouted name, and remembered", () => {
    const pinned = folder("pinned");
    const named = folder("orbit", { "README.md": "# Orbit\n\nDesktop workspace.\n" });
    expect(
      resolveProjectFolder({
        pin: pinned,
        remembered: named,
        userTexts: [`please look at ${named} and Orbit`],
        recentPaths: [named],
      }),
    ).toEqual({ cwd: pinned, source: "pin" });
  });

  it("resolves an absolute folder the user names in ordinary chat", () => {
    const orbit = folder("orbit");
    expect(
      resolveProjectFolder({
        userTexts: [`can you add tests in ${orbit} today?`],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
  });

  it("matches a named project to a recent folder basename or scouted name", () => {
    const orbit = folder("orbit", { "README.md": "# Orbit\n\nDesktop workspace.\n" });
    const other = folder("billing");
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit needs a release note"],
        recentPaths: [other, orbit],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
  });

  it("does not require a command phrase — a name in a normal sentence is enough", () => {
    const tracker = folder("tracker", { "README.md": "# Maus Tracker\n\nTracks every maus.\n" });
    expect(
      resolveProjectFolder({
        userTexts: ["Maus Tracker is the one I meant"],
        recentPaths: [tracker],
      }),
    ).toEqual({ cwd: tracker, source: "named" });
  });

  it("leaves an ambiguous name unresolved so remembered or the private desk can win", () => {
    const first = folder("app");
    const second = folder("app");
    expect(
      resolveProjectFolder({
        userTexts: ["app needs a fix"],
        recentPaths: [first, second],
        remembered: first,
      }),
    ).toEqual({ cwd: first, source: "remembered" });
    expect(
      resolveProjectFolder({
        userTexts: ["app needs a fix"],
        recentPaths: [first, second],
      }),
    ).toEqual({ cwd: null, source: null });
  });

  it("uses the last valid path in the newest message, then remembered when nothing is named", () => {
    const older = folder("older");
    const newer = folder("newer");
    expect(
      resolveProjectFolder({
        remembered: older,
        userTexts: [`started in ${older}`, `switch to ${newer} after lunch`],
      }),
    ).toEqual({ cwd: newer, source: "named" });
    expect(
      resolveProjectFolder({
        remembered: older,
        userTexts: ["thanks — ship it"],
      }),
    ).toEqual({ cwd: older, source: "remembered" });
  });

  it("ignores a missing remembered folder and a path that is not a directory", () => {
    const gone = join(tmpdir(), `omb-missing-${Date.now()}`);
    const fileParent = folder();
    const file = join(fileParent, "notes.txt");
    writeFileSync(file, "x");
    expect(resolveProjectFolder({ remembered: gone })).toEqual({ cwd: null, source: null });
    expect(resolveProjectFolder({ userTexts: [`open ${file}`] })).toEqual({ cwd: null, source: null });
  });

  it("does not treat a private bot workspace as a named project", () => {
    const desk = folder("bot-desk");
    expect(
      resolveProjectFolder({
        userTexts: [`${basename(desk)} please`],
        recentPaths: [desk],
        isPrivateWorkspace: (cwd) => cwd === desk,
      }),
    ).toEqual({ cwd: null, source: null });
  });
});

describe("applyResolvedProjectFolder", () => {
  it("remembers only a newly named project, not a pin or a prior remember", () => {
    const named = folder("named");
    const remembered = folder("remembered");
    const pinned = folder("pinned");
    const namedCalls: string[] = [];
    expect(
      applyResolvedProjectFolder({
        pin: pinned,
        remembered,
        userTexts: [`use ${named}`],
        recentPaths: [named],
        remember: (cwd) => namedCalls.push(cwd),
      }),
    ).toBe(pinned);
    expect(namedCalls).toEqual([]);

    expect(
      applyResolvedProjectFolder({
        remembered,
        userTexts: ["keep going"],
        recentPaths: [named],
        remember: (cwd) => namedCalls.push(cwd),
      }),
    ).toBe(remembered);
    expect(namedCalls).toEqual([]);

    expect(
      applyResolvedProjectFolder({
        remembered,
        userTexts: [`Maus Tracker lives in ${named}`],
        recentPaths: [],
        remember: (cwd) => namedCalls.push(cwd),
      }),
    ).toBe(named);
    expect(namedCalls).toEqual([named]);
  });
});

describe("projectPathsFromRecords", () => {
  it("collects pins, remembered folders, task folders, and room folders without empties", () => {
    expect(
      projectPathsFromRecords({
        bots: [
          {
            cwd: "/tmp/bot-pin",
            lastProjectCwd: "/tmp/remembered",
            tasks: [{ cwd: "/tmp/task" }, { cwd: null }, {}],
          },
          {},
        ],
        groups: [{ cwd: "/tmp/room" }, {}],
      }),
    ).toEqual(["/tmp/bot-pin", "/tmp/remembered", "/tmp/task", "/tmp/room"]);
  });
});

describe("userProjectTexts", () => {
  it("keeps user chat lines and the current send, skipping bot chrome", () => {
    expect(
      userProjectTexts(
        [
          { role: "user", kind: "text", text: "Orbit first" },
          { role: "bot", kind: "text", text: "on it" },
          { role: "user", kind: "activity", text: "ignored" },
          { role: "user", kind: "text", text: "  " },
        ],
        "and the billing folder",
      ),
    ).toEqual(["Orbit first", "and the billing folder"]);
  });
});

describe("1:1 dispatch wiring", () => {
  it("resolves and remembers on 1:1 turns, and leaves room pins on groupTurnCwd", () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(index).toContain("applyResolvedProjectFolder");
    expect(index).toContain("rememberProjectCwd");
    expect(index).toContain("userProjectTexts");
    expect(index).toContain("projectPathsFromRecords");
    expect(index).toContain("namedByUser");
    expect(index).toContain("lastProjectCwd: _lastProjectCwd");
    const roomDispatch = index.slice(index.indexOf("const cwd = groupTurnCwd"));
    expect(roomDispatch).toContain("store.pinGroupCwd");
    expect(roomDispatch.slice(0, 400)).not.toContain("applyResolvedProjectFolder");
  });
});
