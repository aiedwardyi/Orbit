import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

import { catchUpTurns, decodeTurns, forgetTurns, heldTurns, loadTurns } from "./turn-index";

const typed = (id: string, at: number, text = id): Message => ({ id, at, role: "user", kind: "text", text });
const reply = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text: "ok" });
const wire = { ids: ["a", "b"], at: [1_760_000_000, 90], words: ["first", "second"], media: [0, 2], first: "hello" };

function serve() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(String(url));
    return Response.json(wire);
  }));
  return calls;
}

afterEach(() => {
  forgetTurns();
  vi.unstubAllGlobals();
});

describe("turn index loader", () => {
  it("asks for nothing until a rail needs it, then once per chat", async () => {
    const calls = serve();
    expect(heldTurns("t1")).toBeNull();
    expect(calls).toEqual([]);
    const [one, two] = await Promise.all([loadTurns("t1"), loadTurns("t1")]);
    expect(one).toBe(two);
    expect(await loadTurns("t1")).toBe(one);
    expect(heldTurns("t1")).toBe(one);
    expect(calls).toEqual(["/api/threads/t1/turns"]);
  });

  it("turns second gaps into times", () => {
    expect(decodeTurns(wire)).toMatchObject({ ids: ["a", "b"], at: [1_760_000_000_000, 1_760_000_090_000], media: [0, 2], first: "hello", stale: false });
  });

  it("asks again once the index went stale", async () => {
    const calls = serve();
    const turns = await loadTurns("t1");
    turns.stale = true;
    expect(heldTurns("t1")).toBeNull();
    expect(await loadTurns("t1")).not.toBe(turns);
    expect(calls).toHaveLength(2);
  });
});

describe("catching up with the live list", () => {
  const loaded = () => decodeTurns({ ids: ["a", "b"], at: [100, 60], words: ["a", "b"], media: [0, 0], first: "a" });

  it("adds what the user typed and what other bots sent, and nothing else", () => {
    const turns = loaded();
    const live = [typed("a", 100_000), reply("r1", 101_000), typed("b", 160_000), reply("r2", 161_000)];
    expect(catchUpTurns(turns, live)).toBe(false);
    const grown = [
      ...live,
      typed("c", 200_000, "Fix the build\n\nnow"),
      { id: "tool", at: 201_000, role: "bot", kind: "activity", tool: { name: "Bash", ok: true } } satisfies Message,
      { id: "note", at: 202_000, role: "bot", kind: "note", text: "[pane 1a2b3c4d] done" } satisfies Message,
      { ...typed("peer", 203_000, "Review this"), from: { botId: "b", name: "Reviewer", color: "blue" } } satisfies Message,
      reply("r3", 204_000),
    ];
    expect(catchUpTurns(turns, grown)).toBe(true);
    expect(turns.ids).toEqual(["a", "b", "c", "peer"]);
    expect(turns.words.slice(2)).toEqual(["Fix the build now", "Review this"]);
    expect(turns.at.slice(2)).toEqual([200_000, 203_000]);
    expect(turns.version).toBe(1);
    expect(catchUpTurns(turns, [...grown])).toBe(false);
  });

  it("marks the attachments of turns it folds in", () => {
    const turns = loaded();
    const image = '<attached-image path="C:/a/shot.png" />';
    const file = '<attached-file path="C:/a/notes.txt" name="notes.txt" size="12" />';
    const live = [typed("a", 100_000), typed("b", 160_000), typed("c", 200_000, image), typed("d", 210_000, `see ${file}`), typed("e", 220_000, `${file}\n\n${image}`)];
    expect(catchUpTurns(turns, live)).toBe(true);
    expect(turns.media).toEqual([0, 0, 2, 1, 2]);
    expect(turns.words.slice(2)).toEqual(["", "see notes.txt", "notes.txt"]);
  });

  it("skips a list it already folded in without walking it", () => {
    const turns = loaded();
    const live = [typed("a", 100_000), typed("b", 160_000)];
    catchUpTurns(turns, live);
    const findLastIndex = vi.spyOn(live, "findLastIndex");
    expect(catchUpTurns(turns, live)).toBe(false);
    expect(findLastIndex).not.toHaveBeenCalled();
  });

  it("folds in a page that starts after the index ends", () => {
    const turns = loaded();
    expect(catchUpTurns(turns, [reply("r", 170_000), typed("c", 180_000)])).toBe(true);
    expect(turns.ids).toEqual(["a", "b", "c"]);
  });

  it("waits when the index already has a turn the list has not received", () => {
    const turns = loaded();
    expect(catchUpTurns(turns, [typed("a", 100_000), reply("r", 150_000)])).toBe(false);
    expect(turns.stale).toBe(false);
    expect(catchUpTurns(turns, [typed("a", 100_000), reply("r", 150_000), typed("b", 160_000), typed("c", 170_000)])).toBe(true);
    expect(turns.ids).toEqual(["a", "b", "c"]);
  });

  it("goes stale when an edit moves the chat off the indexed path", () => {
    const turns = loaded();
    catchUpTurns(turns, [typed("a", 100_000), typed("b", 160_000)]);
    expect(catchUpTurns(turns, [typed("a", 100_000), typed("b2", 300_000, "edited")])).toBe(false);
    expect(turns.stale).toBe(true);
  });

  describe("goes stale when the chat moves back to a branch that ends earlier", () => {
    const three = () => decodeTurns({ ids: ["a", "b", "c"], at: [100, 60, 60], words: ["a", "b", "c"], media: [0, 0, 0], first: "a" });
    const shown = [typed("a", 100_000), typed("b", 160_000), typed("c", 220_000)];
    it.each([
      ["an older branch", [typed("a", 100_000), typed("b-old", 150_000), reply("old-reply", 151_000)]],
      ["a shorter branch", [typed("a", 100_000), reply("a-reply", 101_000)]],
      ["an edit of the last turn in the same second", [typed("a", 100_000), typed("b", 160_000), typed("c-new", 220_500)]],
    ])("%s", (_, branch) => {
      const turns = three();
      catchUpTurns(turns, shown);
      expect(catchUpTurns(turns, branch)).toBe(false);
      expect(turns.stale).toBe(true);
    });

    it("an edit of the last turn in the same second, before the index caught up", () => {
      const turns = three();
      expect(catchUpTurns(turns, [typed("a", 100_000), typed("b", 160_000), typed("c-new", 220_500)])).toBe(false);
      expect(turns.stale).toBe(true);
    });
  });
});
