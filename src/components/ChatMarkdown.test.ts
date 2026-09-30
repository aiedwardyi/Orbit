// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { ChatMarkdown, isRelativeHref, resolveRelativePath } from "./ChatMarkdown";

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
        "Save a copy — /home/me/proj/reps.py",
        "Save a copy — /tmp/a.py",
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

  it("says why when the resolved file is missing", async () => {
    const saveFile = vi.fn().mockRejectedValue(new Error("That file no longer exists"));
    Object.defineProperty(window, "ogb", { configurable: true, value: { saveFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[gone](gone.py)", baseDir: "/p" })));
      await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
      expect(saveFile).toHaveBeenCalledWith("/p/gone.py", "/p");
      expect(host.textContent).toContain("That file no longer exists");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });
});
