import { describe, expect, it } from "vitest";

import { splitReplyBlocks } from "./turn-stage";

describe("paragraph reply blocks", () => {
  it("keeps reference definitions with their links", () => {
    const text = "See [docs][d].\n\n[d]: https://example.com";
    expect(splitReplyBlocks(text)).toEqual([]);
    expect(splitReplyBlocks(text, true)).toEqual([text]);
    expect(splitReplyBlocks(text, false, text.length)).toEqual([text]);
  });

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

  it.each([
    ["English loose list", "1. First step\n\n   More detail.\n\n2. Second step"],
    ["Korean loose list", "1. 첫 번째 단계\n\n   추가 설명.\n\n2. 두 번째 단계"],
    ["English nested list", "- First\n\n  - Nested\n\n    More detail.\n\n- Second"],
    ["Korean nested list", "- 첫 번째\n\n  - 하위 항목\n\n    추가 설명.\n\n- 두 번째"],
    ["English quote", "> First paragraph\n>\n> Second paragraph"],
    ["Korean quote", "> 첫 번째 문단\n>\n> 두 번째 문단"],
    ["English list fence", "1. Run:\n\n   ```sh\n   echo first\n\n   echo second\n   ```\n\n   Then continue.\n\n2. Finish"],
    ["Korean list fence", "1. 실행:\n\n   ```sh\n   echo 처음\n\n   echo 다음\n   ```\n\n   계속 진행.\n\n2. 완료"],
    ["English indented code", "    first\n\n    second"],
    ["Korean indented code", "    처음\n\n    다음"],
  ])("holds %s until the next top-level block", (_, text) => {
    expect(splitReplyBlocks(`${text}\n\n`)).toEqual([]);
    expect(splitReplyBlocks(`Intro.\n\n${text}\n\nUnfinished`)).toEqual(["Intro.", text]);
  });
});
