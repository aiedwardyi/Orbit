import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACES_DIR } from "./workspace.ts";
import {
  applyResolvedProjectFolder,
  pathContainedBy,
  projectPathsFromRecords,
  projectSearchRoots,
  resolveProjectFolder,
  userProjectTexts,
  visibleSearchChildNames,
} from "./project-folder.ts";

let dirs: string[] = [];

function folder(name?: string, files: Record<string, string> = {}, parent?: string): string {
  const dir = name
    ? (() => {
        const root = parent ?? mkdtempSync(join(tmpdir(), "omb-proj-"));
        if (!parent) dirs.push(root);
        const path = join(root, name);
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
  const tmp = resolvePath(tmpdir());
  for (const dir of dirs) {
    const resolved = resolvePath(dir);
    if (!resolved.startsWith(tmp)) {
      throw new Error(`refusing to delete ${dir} — cleanup is isolated-temp only`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
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

  it("defaults the search walk to an injected home, never the real ~/Projects", () => {
    const home = folder();
    expect(projectSearchRoots(home)).toEqual(
      expect.arrayContaining([home, join(home, "Projects"), join(home, "Desktop"), join(home, "Documents")]),
    );
    expect(dirs.every((dir) => dir.includes("omb-proj-"))).toBe(true);
  });

  it("keeps visible children when hidden names would exhaust the walk budget", () => {
    const hidden = Array.from({ length: 400 }, (_, i) => `.dot-${i}`);
    expect(visibleSearchChildNames([...hidden, "orbit"])).toEqual(["orbit"]);
    expect(visibleSearchChildNames([...hidden, "orbit", "billing"])).toEqual(["orbit", "billing"]);
  });

  it("treats Cafe and Café as the same project name", () => {
    const cafe = folder("Café");
    expect(
      resolveProjectFolder({
        userTexts: ['please look at "Cafe"'],
        recentPaths: [cafe],
      }),
    ).toEqual({ cwd: cafe, source: "named" });
  });

  it("matches a Korean particle after the project name", () => {
    const orbit = folder("orbit");
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit에서 이어서 작업해줘"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit으로 옮겨"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit을 열어줘"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit를 써"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
  });

  it("still honors negation after a Korean particle mention", () => {
    const orbit = folder("orbit");
    const billing = folder("billing");
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["Orbit을 말고"],
        recentPaths: [orbit, billing],
      }),
    ).toEqual({ cwd: null, source: null });
  });

  it("treats mixed Windows slashes as the same containment tree", () => {
    expect(pathContainedBy("C:\\Users\\me", "C:\\Users\\me\\proj")).toBe(true);
    expect(pathContainedBy("C:/Users/me", "C:\\Users\\me\\proj")).toBe(true);
    expect(pathContainedBy("C:\\Users\\me", "C:/Users/other")).toBe(false);
  });

  it("resolves a quoted absolute folder the same as an unquoted path", () => {
    const orbit = folder("orbit");
    expect(
      resolveProjectFolder({
        userTexts: [`please use "${orbit}"`],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
  });

  it("does not treat a folder inside the bot workspaces root as a named project", () => {
    const desk = join(WORKSPACES_DIR, `desk-${Date.now()}`);
    mkdirSync(desk, { recursive: true });
    expect(
      resolveProjectFolder({
        userTexts: [`${basename(desk)} please`],
        recentPaths: [desk],
      }),
    ).toEqual({ cwd: null, source: null });
  });

  it("walks search roots when a named project is not among recent folders", () => {
    const home = folder();
    const orbit = folder("orbit", { "README.md": "# Orbit\n\nDesktop workspace.\n" }, home);
    const other = folder("billing", {}, home);
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit needs a release note"],
        recentPaths: [],
        searchRoots: [home],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
    expect(other).toBeTruthy();
  });

  it("matches an unknown scouted name when the folder basename is not in the sentence", () => {
    const home = folder();
    const orbit = folder("desktop-workspace", { "README.md": "# Orbit\n\nDesktop workspace.\n" }, home);
    expect(
      resolveProjectFolder({
        userTexts: ["Orbit needs a release note"],
        searchRoots: [home],
      }),
    ).toEqual({ cwd: orbit, source: "named" });
  });

  it("still matches a recent folder named like a common home directory", () => {
    const work = folder("work");
    expect(
      resolveProjectFolder({
        userTexts: ["work needs a fix"],
        recentPaths: [work],
      }),
    ).toEqual({ cwd: work, source: "named" });
  });

  it("does not pick a name that stays ambiguous after the search walk", () => {
    const firstRoot = folder();
    const secondRoot = folder();
    const first = folder("app", {}, firstRoot);
    const second = folder("app", {}, secondRoot);
    const remembered = folder("billing");
    expect(
      resolveProjectFolder({
        userTexts: ["app needs a fix"],
        recentPaths: [],
        remembered,
        searchRoots: [firstRoot, secondRoot],
      }),
    ).toEqual({ cwd: remembered, source: "remembered" });
    expect(
      resolveProjectFolder({
        userTexts: ["app needs a fix"],
        recentPaths: [first, second],
        searchRoots: [firstRoot, secondRoot],
      }),
    ).toEqual({ cwd: null, source: null });
  });

  it("does not treat Desktop or Documents as a project just because they sit under home", () => {
    const home = folder();
    folder("Desktop", {}, home);
    folder("Documents", {}, home);
    const remembered = folder("billing");
    expect(
      resolveProjectFolder({
        userTexts: ["please look in Documents"],
        remembered,
        searchRoots: [home],
      }),
    ).toEqual({ cwd: remembered, source: "remembered" });
  });

  it("does not treat a thanks-line as a project name just because a search root has folders", () => {
    const home = folder();
    folder("thanks", {}, home);
    folder("it", {}, home);
    const remembered = folder("billing");
    expect(
      resolveProjectFolder({
        userTexts: ["thanks — ship it"],
        remembered,
        searchRoots: [home],
      }),
    ).toEqual({ cwd: remembered, source: "remembered" });
  });

  it("does not use a remembered folder the user just ruled out", () => {
    const orbit = folder("orbit", { "README.md": "# Orbit\n\nDesktop workspace.\n" });
    const billing = folder("billing");
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["not Orbit"],
        recentPaths: [orbit, billing],
      }),
    ).toEqual({ cwd: null, source: null });
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["don't use Orbit"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: null, source: null });
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["Orbit 말고"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: null, source: null });
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["I'm not using Orbit anymore"],
        recentPaths: [orbit],
      }),
    ).toEqual({ cwd: null, source: null });
  });

  it("skips a negated name and can still take the other project they mentioned", () => {
    const orbit = folder("orbit");
    const billing = folder("billing");
    expect(
      resolveProjectFolder({
        remembered: orbit,
        userTexts: ["don't use Orbit — billing needs the fix"],
        recentPaths: [orbit, billing],
      }),
    ).toEqual({ cwd: billing, source: "named" });
  });

  it("keeps an explicit pin over a search-walk name and over negation", () => {
    const pinned = folder("pinned");
    const home = folder();
    const orbit = folder("orbit", { "README.md": "# Orbit\n\nDesktop workspace.\n" }, home);
    expect(
      resolveProjectFolder({
        pin: pinned,
        remembered: orbit,
        userTexts: ["Orbit needs a release note"],
        searchRoots: [home],
      }),
    ).toEqual({ cwd: pinned, source: "pin" });
    expect(
      resolveProjectFolder({
        pin: pinned,
        remembered: orbit,
        userTexts: ["not Orbit"],
        recentPaths: [orbit],
        searchRoots: [home],
      }),
    ).toEqual({ cwd: pinned, source: "pin" });
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

  it("forgets a remembered folder the user ruled out, and remembers a walk match", () => {
    const orbit = folder("orbit");
    const home = folder();
    const billing = folder("billing", {}, home);
    const forgotten: string[] = [];
    const remembered: string[] = [];
    expect(
      applyResolvedProjectFolder({
        remembered: orbit,
        userTexts: ["not Orbit"],
        recentPaths: [orbit],
        remember: (cwd) => remembered.push(cwd),
        forget: () => forgotten.push("cleared"),
      }),
    ).toBeUndefined();
    expect(remembered).toEqual([]);
    expect(forgotten).toEqual(["cleared"]);

    expect(
      applyResolvedProjectFolder({
        remembered: orbit,
        userTexts: ["billing needs a look"],
        searchRoots: [home],
        remember: (cwd) => remembered.push(cwd),
        forget: () => forgotten.push("cleared"),
      }),
    ).toBe(billing);
    expect(remembered).toEqual([billing]);
    expect(forgotten).toEqual(["cleared"]);
  });

  it("keeps the pin and still forgets a ruled-out remember so it cannot stick later", () => {
    const pinned = folder("pinned");
    const orbit = folder("orbit");
    const calls: string[] = [];
    expect(
      applyResolvedProjectFolder({
        pin: pinned,
        remembered: orbit,
        userTexts: ["not Orbit"],
        recentPaths: [orbit],
        remember: (cwd) => calls.push(`remember:${cwd}`),
        forget: () => calls.push("forget"),
      }),
    ).toBe(pinned);
    expect(calls).toEqual(["forget"]);
  });

  it("does not re-scout a folder apply already resolved when forgetting a remember", () => {
    const orbit = folder("desktop-workspace", { "README.md": "# Orbit\n\nDesktop workspace.\n" });
    let calls = 0;
    const scoutName = (cwd: string) => {
      calls++;
      return cwd === orbit ? "Orbit" : null;
    };
    applyResolvedProjectFolder({
      remembered: orbit,
      userTexts: ["not Orbit"],
      recentPaths: [orbit],
      scoutName,
      remember: () => undefined,
      forget: () => undefined,
    });
    const applyCalls = calls;
    calls = 0;
    resolveProjectFolder({
      remembered: orbit,
      userTexts: ["not Orbit"],
      recentPaths: [orbit],
      scoutName,
    });
    expect(applyCalls).toBe(calls);
  });

  it("does not remember or forget when a pin wins and nothing was ruled out", () => {
    const pinned = folder("pinned");
    const orbit = folder("orbit");
    const calls: string[] = [];
    expect(
      applyResolvedProjectFolder({
        pin: pinned,
        remembered: orbit,
        userTexts: ["keep going"],
        recentPaths: [orbit],
        remember: (cwd) => calls.push(`remember:${cwd}`),
        forget: () => calls.push("forget"),
      }),
    ).toBe(pinned);
    expect(calls).toEqual([]);
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
    expect(index).toContain("forgetProjectCwd");
    expect(index).toContain("userProjectTexts");
    expect(index).toContain("projectPathsFromRecords");
    expect(index).toContain("namedByUser");
    expect(index).toContain("rememberedProjectCwd: lastProjectCwd");
    expect(index).not.toContain("lastProjectCwd: _lastProjectCwd");
    const roomDispatch = index.slice(index.indexOf("const cwd = groupTurnCwd"));
    expect(roomDispatch).toContain("store.pinGroupCwd");
    expect(roomDispatch.slice(0, 400)).not.toContain("applyResolvedProjectFolder");
  });
});
