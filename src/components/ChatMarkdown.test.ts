// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMarkdown, isRelativeHref, resolveRelativePath, settleStreamTail, streamBlocks } from "./ChatMarkdown";
import { applyLocale } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

beforeEach(() => localStorage.setItem("omb-reply-style", "live"));
afterEach(() => localStorage.removeItem("omb-reply-style"));

describe("ChatMarkdown streaming", () => {
  it("preserves code card identity and spoiler state across deltas and settle", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "```js\nconsole.log('stable');\n```\n\n~~answer~~";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, streaming: true })));
      const card = host.querySelector(".chat-md")?.firstElementChild;
      const copy = card?.querySelector("button");
      await act(async () => (host.querySelector('[aria-label="Reveal spoiler"]') as HTMLButtonElement).click());
      await act(async () => root.render(createElement(ChatMarkdown, { text: `${text}\n\nMore text.`, streaming: true })));
      expect.soft(host.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(host.querySelector('[aria-label="Hide spoiler"]')).not.toBeNull();
      await act(async () => root.render(createElement(ChatMarkdown, { text: `${text}\n\nMore text.`, streaming: false })));
      expect.soft(host.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(host.querySelector(".chat-md button")).toBe(copy);
      expect.soft(host.querySelector('[aria-label="Hide spoiler"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatMarkdown paragraphs", () => {
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
    ["English reference", "See [docs][d].\n\n[d]: https://example.com"],
    ["Korean reference", "[문서][d]를 보세요.\n\n[d]: https://example.com"],
  ])("renders %s like history while staged and after settling", async (_, text) => {
    localStorage.setItem("omb-reply-style", "paragraphs");
    const host = document.createElement("div");
    const history = document.createElement("div");
    const root = createRoot(host);
    const historyRoot = createRoot(history);
    try {
      await act(async () => historyRoot.render(createElement(ChatMarkdown, { text })));
      await act(async () => root.render(createElement(ChatMarkdown, { text, streaming: true, whole: text.length })));
      expect(host.innerHTML).toBe(history.innerHTML);
      const settled = `Intro.\n\n${text}\n\nDone.`;
      await act(async () => historyRoot.render(createElement(ChatMarkdown, { text: settled })));
      await act(async () => root.render(createElement(ChatMarkdown, { text: settled })));
      expect(host.innerHTML).toBe(history.innerHTML);
    } finally {
      await act(async () => { root.unmount(); historyRoot.unmount(); });
    }
  });
});

// whitespace between blocks aside
const markup = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text)).replace(/\s*(<[^>]+>)\s*/g, "$1");

const SPLITS: Array<[name: string, text: string, blocks: number]> = [
  ["a loose list", "Steps:\n\n1. First\n\n   More on first.\n\n2. Second\n\nDone.", 2],
  ["a fence with blank lines", "- a\n- b\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nAfter the code.", 3],
  ["a fence in a list item", "1. Install:\n   ```sh\n   npm i\n\n   npm test\n   ```\n\nThat's it.", 2],
  ["a closing fence outside its list", "1. Run:\n   ```sh\n   npm i\n```\n\nNot code?\n\nStill?", 1],
  ["an HTML block", "Intro\n\n<details>\n\nHidden\n\n</details>\n\nOutro", 2],
  ["a reference link", "See [the docs][d].\n\nMore.\n\n[d]: https://example.com", 1],
  ["headings, tables and quotes", "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n> another\n\n***\n\nEnd", 6],
  ["indented code", "Para\n\n    code line\n\n    more code\n\nAfter", 2],
];

describe("streaming blocks", () => {
  it("leaves finished blocks untouched as a reply grows", () => {
    const settled = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} with **bold** words.`).join("\n\n");
    const before = streamBlocks(`${settled}\n\nThe tail`);
    const after = streamBlocks(`${settled}\n\nThe tail grows`);
    expect(before).toHaveLength(31);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).toBe("The tail grows");
  });

  it.each(SPLITS)("splits %s only where each block renders as in the whole reply", (_, text, blocks) => {
    const split = streamBlocks(text);
    expect(split).toHaveLength(blocks);
    expect(split.join("")).toBe(text);
    expect(split.map(markup).join("")).toBe(markup(text));
  });
});

describe("streaming tail", () => {
  it.each([
    ["First I will **check the con", "First I will **check the con**"],
    ["make sure the `stag", "make sure the `stag`"],
    ["**bold `code", "**bold `code`**"],
    ["**check the config*", "**check the config**"],
    ["clean. Then **", "clean. Then "],
    ["the `staging` branch `", "the `staging` branch "],
    ["Done.\n\n- ", "Done.\n\n"],
    ["Done.\n2.", "Done.\n"],
    ["- **Run", "- **Run**"],
  ])("paints %j as %j", (tail, painted) => {
    expect(settleStreamTail(tail)).toBe(painted);
  });

  it.each([
    "First I will **check the config** and",
    "the `staging` branch",
    "- Check the env",
    "5 * 3 is fifteen",
    "an escaped \\*star",
    "```bash\necho `date` **",
    "Use *.ts files in the build",
    "2*3 equals six",
    "glob **/*.md",
    "use *args and **kwar",
    "Use `a*`",
    "Use `a*` and",
    "1",
    "42",
    "2026",
    "Done.\n2026",
    "Keep \\*",
    "type \\`",
    "````md\n```\n**not closed",
    "~~~\n```\n**not closed",
    "    indented **code",
    "\t**tabbed",
    "**first\nsecond",
  ])("leaves %j alone", (tail) => {
    expect(settleStreamTail(tail)).toBe(tail);
  });

  it("never paints styling the settled reply does not have", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const reply = "Use *.ts files, 2*3 equals six, glob **/*.md and `a*` here.\n\n2026\n\n```js\nconst x = 2 * 3; // **not bold**\n```\n\n    indented **code\n\nThen **check the config** and `staging`, then *done*.";
    const styled = () => [...host.querySelectorAll(".chat-md :is(em, strong, code)")].map((el) => [el.tagName, el.textContent ?? ""] as const);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: reply, streaming: false })));
      const settled = styled();
      for (let at = 1; at <= reply.length; at++) {
        await act(async () => root.render(createElement(ChatMarkdown, { text: reply.slice(0, at), streaming: true })));
        for (const [tag, text] of styled()) {
          expect.soft(settled.some(([t, full]) => t === tag && full.startsWith(text)), `${tag} ${JSON.stringify(text)} at ${at}`).toBe(true);
        }
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("never shows a raw marker or an empty bullet while a reply types out", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const reply = "First I will **check the config** and make sure the `staging` branch is clean.\n\n- Check the environment\n- Run the build";
    try {
      for (let at = 1; at <= reply.length; at++) {
        await act(async () => root.render(createElement(ChatMarkdown, { text: reply.slice(0, at), streaming: true })));
        const md = host.querySelector(".chat-md")!;
        expect.soft(md.textContent, reply.slice(0, at)).not.toMatch(/[*`]/);
        expect.soft([...md.querySelectorAll("li")].filter((li) => !li.textContent?.trim()), reply.slice(0, at)).toHaveLength(0);
      }
      await act(async () => root.render(createElement(ChatMarkdown, { text: reply, streaming: false })));
      expect(host.querySelector(".chat-md strong")?.textContent).toBe("check the config");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("relative file links", () => {
  it.each(["precision", "tui", "ledger"] as const)("does not measure file-only lines in %s", async (skin) => {
    applySkin(skin);
    const measure = vi.spyOn(HTMLElement.prototype, "toggleAttribute");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts)", streaming: true })));
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts) more", streaming: true })));
      expect(measure.mock.calls.filter(([name]) => name === "data-file-line")).toHaveLength(0);
      expect(host.querySelector("[data-file-line]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      measure.mockRestore();
      applySkin("precision");
    }
  });

  it("updates a Terminal file line when only sibling text streams in", async () => {
    applySkin("terminal");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts)", streaming: true })));
      const link = host.querySelector("[data-file-link]")!;
      expect(link.hasAttribute("data-file-line")).toBe(true);
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts) more", streaming: true })));
      expect(host.querySelector("[data-file-link]")).toBe(link);
      expect(link.hasAttribute("data-file-line")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      applySkin("precision");
    }
  });

  it("measures a file line only when its Terminal text or skin changes", async () => {
    applySkin("terminal");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const props = { text: "[a](/tmp/a.ts)", streaming: true };
      await act(async () => root.render(createElement(ChatMarkdown, props)));
      const link = host.querySelector("[data-file-link]")!;
      const measure = vi.spyOn(link, "toggleAttribute");
      await act(async () => root.render(createElement(ChatMarkdown, { ...props, streaming: false })));
      expect(measure).not.toHaveBeenCalled();
      await act(async () => applySkin("precision"));
      expect(link.hasAttribute("data-file-line")).toBe(false);
      await act(async () => applySkin("terminal"));
      expect(host.querySelector("[data-file-link]")).toBe(link);
      expect(link.hasAttribute("data-file-line")).toBe(true);
      measure.mockRestore();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      applySkin("precision");
    }
  });

  it("resolves against a Windows base", () => {
    const base = "C:\\Users\\me\\proj";
    expect(resolveRelativePath("reps.py", base)).toBe("C:\\Users\\me\\proj\\reps.py");
    expect(resolveRelativePath("src/app.py", base)).toBe("C:\\Users\\me\\proj\\src\\app.py");
    expect(resolveRelativePath("./notes.md", base)).toBe("C:\\Users\\me\\proj\\notes.md");
    expect(resolveRelativePath("src\\..\\x.txt", base)).toBe("C:\\Users\\me\\proj\\x.txt");
    expect(resolveRelativePath("..\\x.txt", base)).toBeNull();
    expect(resolveRelativePath("../../../../x.txt", "C:/proj/")).toBeNull();
  });

  it("resolves against a POSIX base", () => {
    expect(resolveRelativePath("reps.py", "/home/me/proj")).toBe("/home/me/proj/reps.py");
    expect(resolveRelativePath("a/../b/./c.txt", "/home/me/proj/")).toBe("/home/me/proj/b/c.txt");
    expect(resolveRelativePath("..\\x.txt", "/home/me/proj")).toBeNull();
    expect(resolveRelativePath("../../../../x.txt", "/home/me")).toBeNull();
  });

  it("refuses a link that climbs out of the bot's folder", () => {
    const base = "C:\\Users\\audit\\.orbit\\workspaces\\bot-a";
    expect(resolveRelativePath("%2e%2e/bot-b/private.txt", base)).toBeNull();
    expect(resolveRelativePath("docs/%2E%2E/%2e%2e/bot-b/private.txt", base)).toBeNull();
    expect(resolveRelativePath("docs/%2e%2e/report.md", base)).toBe(`${base}\\report.md`);
  });

  it("decodes escapes and drops a fragment or query", () => {
    expect(resolveRelativePath("my%20file.py#L3", "/p")).toBe("/p/my file.py");
    expect(resolveRelativePath("a.py?x=1", "/p")).toBe("/p/a.py");
    expect(resolveRelativePath("100%.txt", "/p")).toBe("/p/100%.txt");
  });

  it("has nothing to open without a usable base or for #anchor and ?query", () => {
    expect(resolveRelativePath("reps.py")).toBeNull();
    expect(resolveRelativePath("reps.py", null)).toBeNull();
    expect(resolveRelativePath("reps.py", "relative/dir")).toBeNull();
    expect(resolveRelativePath("#top", "/p")).toBeNull();
    expect(resolveRelativePath("?q=1", "/p")).toBeNull();
  });

  it("treats only scheme-less targets as relative", () => {
    for (const href of ["reps.py", "src/app.py", "./notes.md", "..\\x.txt", "#top", "?q=1"]) {
      expect(isRelativeHref(href)).toBe(true);
    }
    for (const href of ["https://a.com", "http://a.com/x", "mailto:a@b.c", "file:///tmp/a", "C:foo"]) {
      expect(isRelativeHref(href)).toBe(false);
    }
  });

  it("renders file, plain and web links per base folder", async () => {
    const text = "[reps](reps.py) [win](..\\x.txt) [top](#top) [q](?q=1) [web](https://a.com) [abs](/tmp/a.py)";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir: "/home/me/proj" })));
      const buttons = [...host.querySelectorAll("button")].map((b) => b.getAttribute("title"));
      expect(buttons).toEqual([
        "/home/me/proj/reps.py",
        "/tmp/a.py",
      ]);
      expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://a.com"]);
      expect(host.textContent).toContain("win top");

      await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir: null })));
      expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["abs"]);
      expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://a.com"]);
      expect(host.textContent).toContain("reps win top q");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("opens a file:// link with an escaped space instead of the app origin", async () => {
    const file = "C:/Users/you/OneDrive/Documents/Chat Downloads/Project_Draft_v2_EN.docx";
    const text =
      "[Project_Draft_v2_EN.docx](file:///C:/Users/you/OneDrive/Documents/Chat%20Downloads/Project_Draft_v2_EN.docx)";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("opens a markdown link to a backslash Windows path", async () => {
    const file = "C:\\Users\\you\\Desktop\\demo-app\\out\\clip.mp4";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[clip.mp4](${file})` })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("opens an angle-bracketed Windows path with spaces", async () => {
    const file = "C:\\My Drive\\bots\\out\\clip (1).mp4";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[clip.mp4](<${file}>)` })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("renders a link whose target is stripped as plain text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[bad](javascript:alert(1)) [empty]()" })));
      expect(host.querySelector("a")).toBeNull();
      expect(host.querySelector("button")).toBeNull();
      expect(host.textContent).toContain("bad empty");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("says why when the resolved file is missing", async () => {
    const openFile = vi.fn().mockRejectedValue(new Error("That file no longer exists"));
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[gone](gone.py)", baseDir: "/p" })));
      await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
      expect(openFile).toHaveBeenCalledWith("/p/gone.py", "/p");
      expect(host.textContent).toContain("That file no longer exists");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("tells a phone that files open in the desktop app", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[notes.md](C:/My%20Drive/notes.md)" })));
      await act(async () => host.querySelector("button")!.click());
      expect(host.textContent).toContain("Files open in the desktop app");
      expect(host.textContent).not.toContain("newer version");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  describe("link messages by language", () => {
    type Bridge = { openFile?: ReturnType<typeof vi.fn> };
    const clickLink = async (locale: "en" | "ko", ogb: Bridge | undefined, link: string) => {
      if (ogb) Object.defineProperty(window, "ogb", { configurable: true, value: ogb });
      applyLocale(locale);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: link })));
        await act(async () => host.querySelector("button")!.click());
        return host.querySelector("button")!.nextElementSibling?.textContent;
      } finally {
        await act(async () => root.unmount());
        host.remove();
        applyLocale("en");
        Reflect.deleteProperty(window, "ogb");
      }
    };
    const rejecting = (message: string) => ({ openFile: vi.fn().mockRejectedValue(new Error(message)) });

    it("shows a rejected folder link in Korean", async () => {
      const shown = await clickLink("ko", rejecting("That folder could not be opened"), "[shots](C:/Users/me/shots)");
      expect(shown).toBe("폴더를 열 수 없습니다");
    });

    it("shows a rejected file link in Korean", async () => {
      const shown = await clickLink("ko", rejecting("That file no longer exists"), "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일이 더 이상 없습니다");
    });

    it("tells a Korean phone that files open in the desktop app", async () => {
      const shown = await clickLink("ko", undefined, "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일은 데스크톱 앱에서 열 수 있습니다");
    });

    it("tells an older Korean desktop app to update", async () => {
      const shown = await clickLink("ko", {}, "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일을 열려면 데스크톱 앱을 최신 버전으로 업데이트해야 합니다");
    });

    it("keeps the English text in English", async () => {
      const shown = await clickLink("en", rejecting("That folder could not be opened"), "[shots](C:/Users/me/shots)");
      expect(shown).toBe("That folder could not be opened");
    });

    it("shows an unknown message as it came", async () => {
      const shown = await clickLink("ko", rejecting("EPERM: operation not permitted"), "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("EPERM: operation not permitted");
    });
  });

  it("asks an older desktop app without file opening to update", async () => {
    Object.defineProperty(window, "ogb", { configurable: true, value: {} });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[notes.md](C:/My%20Drive/notes.md)" })));
      await act(async () => host.querySelector("button")!.click());
      expect(host.textContent).toContain("Opening files needs a newer version of the desktop app");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  describe("file link right-click", () => {
    const rightClick = async (ogb: object | undefined, text: string, baseDir?: string) => {
      if (ogb) Object.defineProperty(window, "ogb", { configurable: true, value: ogb });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir })));
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        await act(async () => void host.querySelector("button")!.dispatchEvent(event));
        return { prevented: event.defaultPrevented, text: host.textContent };
      } finally {
        await act(async () => root.unmount());
        host.remove();
        Reflect.deleteProperty(window, "ogb");
      }
    };

    it("opens the native menu and keeps the browser menu away", async () => {
      const fileMenu = vi.fn().mockResolvedValue(undefined);
      const openFile = vi.fn();
      const result = await rightClick({ fileMenu, openFile }, "[1080p](clip.mp4)", "/p");
      expect(fileMenu).toHaveBeenCalledWith("/p/clip.mp4", "/p");
      expect(openFile).not.toHaveBeenCalled();
      expect(result.prevented).toBe(true);
    });

    it("leaves the default menu alone without the bridge", async () => {
      expect((await rightClick(undefined, "[notes](C:/My%20Drive/notes.md)")).prevented).toBe(false);
      const older = await rightClick({ openFile: vi.fn() }, "[notes](C:/My%20Drive/notes.md)");
      expect(older.prevented).toBe(false);
    });

    it("says why when the file is rejected", async () => {
      const fileMenu = vi.fn().mockRejectedValue(new Error("That file no longer exists"));
      const result = await rightClick({ fileMenu }, "[gone](gone.py)", "/p");
      expect(result.prevented).toBe(true);
      expect(result.text).toContain("That file no longer exists");
    });
  });

  it("waits to play a video and opens a pdf in a new tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "[clip.mp4](C:/clips/clip.mp4)\n\n[notes.pdf](C:/clips/notes.pdf)";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, threadId: "t1" })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("video")).not.toBeNull();
        });
      });
      const video = host.querySelector("video")!;
      expect(video.hasAttribute("autoplay")).toBe(false);
      expect(video.muted).toBe(false);
      expect(video.getAttribute("preload")).toBe("metadata");
      const pdf = host.querySelector('[data-phone-media="pdf"]')!;
      expect(pdf.tagName).toBe("A");
      expect(pdf.getAttribute("target")).toBe("_blank");
      expect(pdf.getAttribute("rel")).toBe("noreferrer");
      expect(pdf.textContent).toBe("notes.pdf");
      expect(host.querySelector("iframe")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the file name beside Open on PC", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/devices")) {
        return new Response(JSON.stringify({
          devices: [{ deviceId: "home-pc", name: "Home", host: "home.example", current: false }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ deviceId: "home-pc" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, {
        text: "[clip.mp4](C:/clips/clip.mp4)",
        threadId: "t1",
      })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("[data-open-on-pc]")).not.toBeNull();
        });
      });
      expect(host.textContent).toContain("clip.mp4");
      expect(host.textContent).toContain("Open on Home");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
