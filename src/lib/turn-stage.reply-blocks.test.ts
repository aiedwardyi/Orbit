import { describe, expect, it } from "vitest";

import { splitReplyBlocks } from "./turn-stage";

describe("paragraph reply blocks", () => {
  it.each([
    ["paragraph", "One thought.\n\n", "One thought."],
    ["heading", "## Heading\n\n", "## Heading"],
    ["list", "- First\n- Second\n\n", "- First\n- Second"],
    ["table", "| A | B |\n|---|---|\n| 1 | 2 |\n\n", "| A | B |\n|---|---|\n| 1 | 2 |"],
    ["quote", "> First\n> Second\n\n", "> First\n> Second"],
    ["fenced code", "```js\nconst a = 1;\n\nconst b = 2;\n```", "```js\nconst a = 1;\n\nconst b = 2;\n```"],
    ["tilde fence", "~~~~txt\nfirst\n\n```\nsecond\n~~~~\n", "~~~~txt\nfirst\n\n```\nsecond\n~~~~"],
    ["Windows blank line", "First.\r\n \t\r\n", "First."],
  ])("finishes a %s as one block", (_, text, block) => {
    expect(splitReplyBlocks(`${text}${text.endsWith("\n") ? "" : "\n"}Unfinished`)).toEqual([block]);
  });

  it("holds an unfinished paragraph and a fence with a blank line inside", () => {
    expect(splitReplyBlocks("Still writing")).toEqual([]);
    expect(splitReplyBlocks("Done.\n\n```js\nfirst\n\nsecond")).toEqual(["Done."]);
  });

  it("releases an unfinished fence and paragraph at turn end", () => {
    expect(splitReplyBlocks("```js\nfirst\n\nsecond", true)).toEqual(["```js\nfirst\n\nsecond"]);
    expect(splitReplyBlocks("Done.\n\nTail", true)).toEqual(["Done.", "Tail"]);
  });
});
