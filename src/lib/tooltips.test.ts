// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeTooltip } from "./tooltip-position";
import { mountGlobalTooltips } from "./tooltips";

let unmount = () => {};

const tip = () => document.querySelector("[data-global-tip]");
const flushMutations = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const over = (target: EventTarget, init: PointerEventInit = {}) =>
  target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", ...init }));
const out = (target: EventTarget, relatedTarget: EventTarget | null = null) =>
  target.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget }));
const stubRect = (el: Element, left: number, top: number, width: number, height = 20) => {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top }) as DOMRect;
};
const titled = (title: string, parent: HTMLElement = document.body) => {
  const el = document.createElement("button");
  el.setAttribute("title", title);
  el.textContent = title;
  parent.append(el);
  return el;
};
const hoverAndShow = (el: Element) => {
  over(el);
  vi.advanceTimersByTime(400);
  return tip();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  unmount = mountGlobalTooltips();
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("chain stash", () => {
  it("stashes every title in the chain synchronously and shows the innermost", () => {
    const row = titled("outer");
    const btn = titled("inner", row);
    over(btn);
    expect(btn.getAttribute("title")).toBeNull();
    expect(row.getAttribute("title")).toBeNull();
    expect(btn.getAttribute("data-tip")).toBe("inner");
    vi.advanceTimersByTime(400);
    expect(tip()?.textContent).toBe("inner");
  });

  it("restores every title on leave", () => {
    const row = titled("outer");
    const btn = titled("inner", row);
    hoverAndShow(btn);
    out(btn, document.body);
    expect(btn.getAttribute("title")).toBe("inner");
    expect(row.getAttribute("title")).toBe("outer");
    expect(btn.hasAttribute("data-tip")).toBe(false);
    expect(tip()).toBeNull();
  });

  it("keeps the tip moving within the anchor", () => {
    const btn = titled("inner");
    const icon = document.createElement("span");
    btn.append(icon);
    hoverAndShow(btn);
    out(btn, icon);
    over(icon);
    expect(tip()?.textContent).toBe("inner");
    expect(btn.getAttribute("title")).toBeNull();
  });

  it("ignores an empty title", () => {
    const btn = titled("");
    over(btn);
    vi.advanceTimersByTime(400);
    expect(tip()).toBeNull();
  });
});

describe("delay", () => {
  it("shows after 400 ms", () => {
    const btn = titled("late");
    over(btn);
    vi.advanceTimersByTime(399);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tip()?.textContent).toBe("late");
  });

  it("does not restart the delay moving within the anchor", () => {
    const btn = titled("steady");
    const icon = document.createElement("span");
    btn.append(icon);
    over(btn);
    vi.advanceTimersByTime(100);
    over(icon);
    vi.advanceTimersByTime(300);
    expect(tip()?.textContent).toBe("steady");
  });

  it("shows at once within 300 ms of a hide", () => {
    const a = titled("a");
    hoverAndShow(a);
    out(a, document.body);
    vi.setSystemTime(Date.now() + 200);
    const b = titled("b");
    over(b);
    expect(tip()?.textContent).toBe("b");
  });

  it("does not open the skip window when the first tip never showed", () => {
    const a = titled("a");
    over(a);
    vi.advanceTimersByTime(100);
    out(a, document.body);
    vi.setSystemTime(Date.now() + 200);
    const b = titled("b");
    over(b);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(399);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tip()?.textContent).toBe("b");
  });

  it("waits the full delay after the skip window", () => {
    const a = titled("a");
    hoverAndShow(a);
    out(a, document.body);
    vi.setSystemTime(Date.now() + 400);
    const b = titled("b");
    over(b);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(400);
    expect(tip()?.textContent).toBe("b");
  });
});

describe("close triggers", () => {
  const triggers: Array<[string, (el: Element) => void]> = [
    ["pointerdown", (el) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }))],
    ["contextmenu", (el) => el.dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, pointerType: "mouse" }))],
    ["wheel", (el) => el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))],
    ["scroll", (el) => el.dispatchEvent(new Event("scroll"))],
    ["keydown", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }))],
    ["blur", () => window.dispatchEvent(new Event("blur"))],
    ["resize", () => window.dispatchEvent(new Event("resize"))],
  ];

  for (const [name, fire] of triggers) {
    it(`hides on ${name} without restoring until leave`, () => {
      const btn = titled("tip");
      hoverAndShow(btn);
      fire(btn);
      expect(tip()).toBeNull();
      expect(btn.getAttribute("title")).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(tip()).toBeNull();
      out(btn, document.body);
      expect(btn.getAttribute("title")).not.toBeNull();
    });
  }

  it("cancels a pending show on pointerdown", () => {
    const btn = titled("nope");
    over(btn);
    vi.advanceTimersByTime(100);
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    vi.advanceTimersByTime(1000);
    expect(tip()).toBeNull();
  });

  it("switches to the next element with no delay right after a hide", () => {
    const row = titled("row");
    const btn = titled("btn", row);
    hoverAndShow(btn);
    out(btn, row);
    over(row);
    expect(tip()?.textContent).toBe("row");
    expect(btn.getAttribute("title")).toBe("btn");
  });
});

describe("live updates", () => {
  it("re-stashes a title React rewrites while shown", async () => {
    const btn = titled("More reactions");
    hoverAndShow(btn);
    btn.setAttribute("title", "Close reactions");
    await flushMutations();
    expect(btn.getAttribute("title")).toBeNull();
    expect(btn.getAttribute("data-tip")).toBe("Close reactions");
    expect(tip()?.textContent).toBe("Close reactions");
  });

  it("re-stashes a rewrite after pointerdown without showing", async () => {
    const btn = titled("More reactions");
    hoverAndShow(btn);
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    expect(tip()).toBeNull();
    btn.setAttribute("title", "Close reactions");
    await flushMutations();
    expect(btn.getAttribute("title")).toBeNull();
    expect(btn.getAttribute("data-tip")).toBe("Close reactions");
    expect(tip()).toBeNull();
  });

  it("keeps the newer title on leave after a hidden rewrite", async () => {
    const btn = titled("More reactions");
    hoverAndShow(btn);
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    btn.setAttribute("title", "Close reactions");
    await flushMutations();
    out(btn, document.body);
    expect(btn.getAttribute("title")).toBe("Close reactions");
  });

  it("closes when its element leaves the DOM", async () => {
    const btn = titled("gone");
    hoverAndShow(btn);
    btn.remove();
    await flushMutations();
    expect(tip()).toBeNull();
  });
});

describe("scroll", () => {
  it("keeps a shown tip on an unrelated scroll", () => {
    const other = document.createElement("div");
    document.body.append(other);
    const btn = titled("tip");
    hoverAndShow(btn);
    other.dispatchEvent(new Event("scroll"));
    expect(tip()?.textContent).toBe("tip");
  });

  it("keeps a pending show on an unrelated scroll", () => {
    const other = document.createElement("div");
    document.body.append(other);
    const btn = titled("tip");
    over(btn);
    vi.advanceTimersByTime(100);
    other.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(300);
    expect(tip()?.textContent).toBe("tip");
  });

  it("hides on a scroll of the anchor's scroller", () => {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const btn = titled("tip", scroller);
    hoverAndShow(btn);
    scroller.dispatchEvent(new Event("scroll"));
    expect(tip()).toBeNull();
  });

  it("hides on a document scroll", () => {
    const btn = titled("tip");
    hoverAndShow(btn);
    document.dispatchEvent(new Event("scroll"));
    expect(tip()).toBeNull();
  });
});

describe("pointers", () => {
  it.each(["touch", "pen"])("ignores %s", (pointerType) => {
    const btn = titled("nope");
    over(btn, { pointerType });
    vi.advanceTimersByTime(1000);
    expect(btn.getAttribute("title")).toBe("nope");
    expect(tip()).toBeNull();
  });
});

describe("text", () => {
  it("keeps multi-line text on separate lines", () => {
    const btn = titled("line one\nline two");
    hoverAndShow(btn);
    expect(tip()?.textContent).toBe("line one\nline two");
    expect(tip()?.className).toContain("whitespace-pre-line");
  });
});

describe("placement", () => {
  it("centres on a narrow element", () => {
    const btn = titled("narrow");
    stubRect(btn, 400, 300, 40);
    over(btn);
    vi.advanceTimersByTime(400);
    const placed = placeTooltip({
      anchor: { top: 300, bottom: 320, left: 400, width: 40 },
      size: { width: 0, height: 0 },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    expect(tip()?.getAttribute("style")).toContain(`top: ${placed.top}px`);
    expect(tip()?.getAttribute("style")).toContain(`left: ${placed.left}px`);
  });

  it("anchors a wide element to the pointer x", () => {
    const row = titled("wide");
    stubRect(row, 100, 300, 400);
    over(row, { clientX: 350 });
    vi.advanceTimersByTime(400);
    const placed = placeTooltip({
      anchor: { top: 300, bottom: 320, left: 350, width: 0 },
      size: { width: 0, height: 0 },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    expect(tip()?.getAttribute("style")).toContain(`top: ${placed.top}px`);
    expect(tip()?.getAttribute("style")).toContain(`left: ${placed.left}px`);
  });

  it("clamps a wide anchor to the element", () => {
    const row = titled("wide");
    stubRect(row, 100, 300, 400);
    over(row, { clientX: 900 });
    vi.advanceTimersByTime(400);
    const placed = placeTooltip({
      anchor: { top: 300, bottom: 320, left: 500, width: 0 },
      size: { width: 0, height: 0 },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    expect(tip()?.getAttribute("style")).toContain(`left: ${placed.left}px`);
  });
});

describe("unmount", () => {
  it("removes the tip and restores titles", () => {
    const btn = titled("bye");
    hoverAndShow(btn);
    unmount();
    unmount = () => {};
    expect(tip()).toBeNull();
    expect(btn.getAttribute("title")).toBe("bye");
  });
});
