import { anchorForTip, placeTooltip } from "./tooltip-position";

/** Delay before a tip shows, and the window after a hide that skips it. */
export const TOOLTIP_SHOW_MS = 400;
export const TOOLTIP_SKIP_MS = 300;

/** Every plain tip shares this: the global layer and the timestamp tip. */
export const PLAIN_TOOLTIP_CLASS =
  "pointer-events-none fixed z-[70] max-w-[min(20rem,calc(100vw-1rem))] whitespace-pre-line rounded-lg border border-hairline/40 bg-panel px-2.5 py-1 text-[12px] leading-snug text-ink shadow-lg animate-tip-in motion-reduce:animate-none";

type Stash = { el: Element; title: string; prevTip: string | null; label: string | null };

/** One tip for every `title` in the app, without touching the props. */
export function mountGlobalTooltips() {
  let stashed: Stash[] = [];
  let anchor: Element | null = null;
  let tipEl: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHideAt = 0;
  let pointerX = 0;
  let observer: MutationObserver | null = null;

  const stashedBy = (el: Element) => stashed.find((s) => s.el === el);
  const isMouse = (e: Event) => (e as PointerEvent).pointerType === "mouse";

  function chainFrom(target: EventTarget | null) {
    const chain: Array<{ el: Element; text: string }> = [];
    let el: Element | null = null;
    if (target instanceof Element) el = target;
    else if (target instanceof Node) el = target.parentElement;
    for (; el; el = el.parentElement) {
      if (el === tipEl) continue;
      const title = el.getAttribute("title");
      if (title) chain.push({ el, text: title });
      else {
        const s = stashedBy(el);
        if (s?.title) chain.push({ el, text: s.title });
      }
    }
    return chain;
  }

  function stash(chain: Array<{ el: Element; text: string }>) {
    for (const { el, text } of chain) {
      const prevTip = el.getAttribute("data-tip");
      const label = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim() && !el.querySelector("img[alt]:not([alt='']), [aria-label], [aria-labelledby]") ? text : null;
      if (label !== null) el.setAttribute("aria-label", label);
      // An empty title suppresses the native tip and keeps React removals observable.
      el.setAttribute("title", "");
      el.setAttribute("data-tip", text);
      stashed.push({ el, title: text, prevTip, label });
    }
  }

  function restore() {
    for (const s of stashed) {
      // React may have set a newer title since the stash.
      if (s.title && s.el.getAttribute("title") === "") s.el.setAttribute("title", s.title);
      if (s.label !== null && s.el.getAttribute("aria-label") === s.label) s.el.removeAttribute("aria-label");
      if (s.prevTip === null) s.el.removeAttribute("data-tip");
      else s.el.setAttribute("data-tip", s.prevTip);
    }
    stashed = [];
  }

  function cancelPending() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function hide() {
    cancelPending();
    const shown = tipEl !== null;
    tipEl?.remove();
    tipEl = null;
    if (shown) lastHideAt = Date.now();
  }

  function teardown() {
    if (!anchor) return;
    hide();
    anchor = null;
    observer?.disconnect();
    observer = null;
    restore();
  }

  function render(el: Element, text: string) {
    const tip = document.createElement("div");
    tip.className = PLAIN_TOOLTIP_CLASS;
    tip.setAttribute("data-global-tip", "");
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    tip.style.maxHeight = `${window.innerHeight * 0.4}px`;
    tip.style.overflow = "hidden";
    tip.style.overflowWrap = "anywhere";
    tip.style.top = "0";
    tip.style.left = "0";
    tip.style.visibility = "hidden";
    document.body.append(tip);
    if (tip.scrollHeight > tip.clientHeight) tip.style.maskImage = "linear-gradient(to bottom, black calc(100% - 1.5em), transparent)";
    const size = tip.getBoundingClientRect();
    const box = placeTooltip({
      anchor: anchorForTip(el.getBoundingClientRect(), pointerX),
      size: { width: size.width, height: size.height },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    tip.style.top = `${box.top}px`;
    tip.style.left = `${box.left}px`;
    tip.style.visibility = "visible";
    tipEl?.remove();
    tipEl = tip;
  }

  function observe(el: Element) {
    observer?.disconnect();
    const o = new MutationObserver((records) => {
      if (!anchor || !anchor.isConnected) {
        teardown();
        return;
      }
      for (const s of stashed) {
        const changes = records.filter((record) => record.type === "attributes" && record.target === s.el);
        if (!changes.length) continue;
        const title = s.el.getAttribute("title");
        if (title === "" && changes.every((record) => record.oldValue === s.title)) continue;
        if (!title) {
          s.title = "";
          if (s.label !== null && s.el.getAttribute("aria-label") === s.label) s.el.removeAttribute("aria-label");
          s.label = null;
          if (s.prevTip === null) s.el.removeAttribute("data-tip");
          else s.el.setAttribute("data-tip", s.prevTip);
          if (s.el === anchor) hide();
          continue;
        }
        s.title = title;
        if (s.label !== null && s.el.getAttribute("aria-label") === s.label) {
          s.el.setAttribute("aria-label", title);
          s.label = title;
        }
        s.el.setAttribute("title", "");
        s.el.setAttribute("data-tip", title);
        if (tipEl && s.el === anchor) render(anchor, title);
      }
    });
    observer = o;
    for (const s of stashed) o.observe(s.el, { attributes: true, attributeFilter: ["title"], attributeOldValue: true });
    // the anchor's own removal fires on its parent, a row's on the grandparent
    for (let parent = el.parentElement; parent; parent = parent.parentElement) o.observe(parent, { childList: true });
  }

  function show() {
    timer = null;
    const el = anchor;
    const s = el && stashedBy(el);
    if (!el || !s?.title || !el.isConnected) {
      teardown();
      return;
    }
    const fresh = el.getAttribute("title");
    if (fresh) {
      s.title = fresh;
      el.setAttribute("title", "");
      el.setAttribute("data-tip", fresh);
    }
    render(el, s.title);
  }

  function onOver(e: Event) {
    if (!isMouse(e)) return;
    pointerX = (e as PointerEvent).clientX;
    const chain = chainFrom(e.target);
    const next = chain.length > 0 ? chain[0].el : null;
    if (next === anchor) return;
    const skip = Date.now() - lastHideAt <= TOOLTIP_SKIP_MS;
    teardown();
    if (!next) return;
    // Blink reads the hovered title for its own tip after this event
    // returns, so the stash must stay synchronous.
    stash(chain);
    anchor = next;
    observe(next);
    if (skip) show();
    else timer = setTimeout(show, TOOLTIP_SHOW_MS);
  }

  function onOut(e: Event) {
    if (!isMouse(e) || !anchor) return;
    const to = (e as PointerEvent).relatedTarget;
    if (to instanceof Node && anchor.contains(to)) return;
    teardown();
  }

  function onMove(e: Event) {
    if (isMouse(e)) pointerX = (e as PointerEvent).clientX;
  }

  function onHide() {
    if (anchor) hide();
  }

  function onScroll(e: Event) {
    const el = anchor;
    if (!el) return;
    const t = e.target;
    // A transcript follow scroll must not cancel a sidebar tip.
    if (t === document) hide();
    else if (t instanceof Node && t.contains(el)) hide();
  }

  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerdown", onHide, true);
  document.addEventListener("contextmenu", onHide, true);
  document.addEventListener("wheel", onHide, { capture: true, passive: true });
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("keydown", onHide, true);
  window.addEventListener("blur", onHide);
  window.addEventListener("resize", onHide);

  return () => {
    document.removeEventListener("pointerover", onOver, true);
    document.removeEventListener("pointerout", onOut, true);
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerdown", onHide, true);
    document.removeEventListener("contextmenu", onHide, true);
    document.removeEventListener("wheel", onHide, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("keydown", onHide, true);
    window.removeEventListener("blur", onHide);
    window.removeEventListener("resize", onHide);
    teardown();
  };
}
