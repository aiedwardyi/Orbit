// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vitest";

import { ChatMarkdown, isRelativeHref, resolveRelativePath, settleStreamTail, streamBlocks } from "./ChatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

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
    const file = "C:/Users/mredw/OneDrive/Documents/KakaoTalk Downloads/POKKEY_Patent_Draft_v2_EN.docx";
    const text =
      "[POKKEY_Patent_Draft_v2_EN.docx](file:///C:/Users/mredw/OneDrive/Documents/KakaoTalk%20Downloads/POKKEY_Patent_Draft_v2_EN.docx)";
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
    const file = "C:\\Users\\mredw\\Desktop\\pokkey\\out\\clip.mp4";
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
