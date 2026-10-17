// The timeline rail: a faint line at the transcript edge, a lens that zooms where the pointer
// slows, and a glass card of the turns around the pick. Per frame only transforms, opacity and the lens canvas change.
import { hapticTick } from "./phone-swipe";
import type { Turns } from "./turn-index";
import { cardLayout, dayNumbers, fitWords, lensOut, lowerBound, railFrame, railPick, railPositions, rowAt, type CardLayout, type RailFrame } from "./turn-rail";

export interface TurnRailHooks {
  /** The chat's index, caught up with the live list; null when it cannot load. */
  turns(): Promise<Turns | null>;
  /** Folds turns the live list gained into `turns`; true when it grew. */
  catchUp(turns: Turns): boolean;
  jump(messageId: string): void;
  latest(): void;
  wheel(deltaY: number): void;
  day(ms: number): string;
  time(ms: number): string;
  label(): string;
  valueText(at: number, words: string): string;
}

export interface TurnRail {
  setThread(threadId: string): void;
  setFollowing(following: boolean): void;
  setEnabled(enabled: boolean): void;
  /** The Jump to latest pill showed or hid; the card keeps clear of it. */
  setLatestShown(shown: boolean): void;
  /** Skin or language changed. */
  restyle(): void;
  /** The live message list changed. */
  liveChanged(): void;
  destroy(): void;
}

type Spring = { x: number; v: number; to: number };
type Mode = "idle" | "rail" | "card" | "drag" | "open" | "key";
type Touch = { id: number; x0: number; y0: number; s0: number; t0: number; axis: "" | "x" | "y"; stop: boolean; pts: [number, number, number][] };

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const spring = (x = 0): Spring => ({ x, v: 0, to: x });
const snap = (s: Spring, x: number) => {
  s.x = s.to = x;
  s.v = 0;
};
const div = (className: string) => {
  const el = document.createElement("div");
  el.className = className;
  return el;
};

const TICK_W = 14;
const REST = 0.12;
const LENS_W = 24;
// px per turn of the approved mock (600 turns); a denser rail draws every few turns at about this spacing
const DRAW_PITCH = 1.25;
const PAD = 4;
const VISIBLE = 7;
const NOTCH = 50;
const FLING_MS = 360;
const POOL_ROWS = 16;
const POOL_HEADS = 6;
const RETRY_MS = 10_000;
const INTENT_MS = 80;
const INTENT_PX = 6;
const GUARD_MS = 300;
const KEY_STEP = new Map([["ArrowUp", -1], ["ArrowDown", 1], ["PageUp", -VISIBLE], ["PageDown", VISIBLE]]);
const WARM_FRAMES = 9;
let warmed = false;

export function createTurnRail(host: HTMLElement, scroller: HTMLElement, hooks: TurnRailHooks): TurnRail {
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hoverless = window.matchMedia("(hover: none)");
  let RM = reducedQuery.matches;
  const onReduced = () => (RM = reducedQuery.matches);
  reducedQuery.addEventListener?.("change", onReduced);

  // Critically damped spring, exact step; true while it moves.
  const step = (s: Spring, w: number, dt: number, eps = 0.002) => {
    const dx = s.x - s.to;
    if (RM || (Math.abs(dx) < eps && Math.abs(s.v) < eps * 20)) {
      const moved = dx !== 0 || s.v !== 0;
      s.x = s.to;
      s.v = 0;
      return moved;
    }
    const e = Math.exp(-w * dt);
    const c0 = s.v + w * dx;
    s.x = s.to + (dx + c0 * dt) * e;
    s.v = (s.v - w * c0 * dt) * e;
    return true;
  };

  const hit = div("turn-rail-hit");
  const vis = div("turn-rail");
  const lensEl = div("turn-rail-lens");
  const canvas = document.createElement("canvas");
  const hereEl = div("turn-rail-here");
  const curEl = div("turn-rail-cur");
  const card = div("turn-card rounded-xl");
  const win = div("turn-card-win");
  const band = div("turn-card-band rounded");
  const strip = div("turn-card-strip");
  const heads = div("turn-card-heads");
  lensEl.append(canvas);
  vis.append(lensEl, hereEl, curEl);
  win.append(band, strip);
  card.append(win, heads);
  host.append(hit, vis, card);
  hit.dataset.noSwipe = "";
  card.dataset.noSwipe = "";
  hit.dataset.turnRailStrip = "";
  card.dataset.turnCard = "";
  hit.setAttribute("role", "slider");
  hit.setAttribute("aria-orientation", "vertical");
  hit.tabIndex = 0;
  host.hidden = true;
  vis.setAttribute("aria-hidden", "true");
  card.setAttribute("aria-hidden", "true");
  const rows = Array.from({ length: POOL_ROWS }, () => {
    const el = div("turn-card-row");
    const time = document.createElement("span");
    const words = document.createElement("span");
    time.className = "turn-card-time";
    words.className = "turn-card-words";
    el.append(time, words);
    strip.append(el);
    return { el, time, words, turn: -1, y: "" };
  });
  const headRows = Array.from({ length: POOL_HEADS }, () => {
    const el = div("turn-card-head");
    heads.append(el);
    return { el, day: -1, y: "" };
  });
  const ctx = canvas.getContext("2d");

  let thread = "";
  let turns: Turns | null = null;
  let version = -1;
  let n = 0;
  let days: Int32Array = new Int32Array(0);
  let loading = false;
  let failedAt = -Infinity;
  let enabled = false;
  let following = true;
  let touch = hoverless.matches;
  let G: RailFrame = railFrame(0, 0, 0);
  let unmeasured = true;
  let box = { left: 0, top: 0 };
  let mode: Mode = "idle";
  let dragId: number | null = null;
  let lastPT = "mouse";
  let leaveTimer = 0;
  let sleepTimer = 0;
  let intentTimer = 0;
  let ax = 0;
  let ay = 0;
  let openedAt = -Infinity;
  let swallowAt = -1;
  let ink = "";
  let inkAlpha = 1;
  let stride = 1;
  let font = "";
  let idIndex: Map<string, number> | null = null;

  const pointY = (e: { clientY: number }) => e.clientY - box.top - G.top;
  const pointX = (e: { clientX: number }) => e.clientX - box.left;
  const refreshBox = () => {
    const rect = host.getBoundingClientRect();
    box = { left: rect.left, top: rect.top };
  };

  const wake = spring();
  const amp = spring();
  const hereY = spring();
  const curY = spring();
  let pos: Float32Array = new Float32Array(0);
  let R = 120;
  let sel = -1;
  let ext = -1;
  let py = 0;
  let on = false;
  let center = 0;
  let zoom = 0;
  let speed = 0;
  let lastY = 0;
  let lastTs = 0;
  let lastMove = 0;
  let locked = false;
  let slowSince = 0;
  let here = -1;
  let rest: HTMLCanvasElement | null = null;
  let drawn = "";
  const disp = (p: number) => lensOut(p, center, R, zoom);

  function pick() {
    const t = railPick(py, G.h, pos, center, R, zoom);
    if (t !== sel && t >= 0) {
      sel = t;
      curY.to = pos[t]!;
      announce();
    }
  }
  function lensEnter(y: number, ts: number) {
    ext = -1;
    on = true;
    py = clamp(y, 0, G.h);
    center = py;
    locked = false;
    slowSince = 0;
    speed = 0;
    lastY = py;
    lastTs = ts;
    lastMove = performance.now();
    amp.to = 1;
    pick();
    if (sel >= 0) snap(curY, pos[sel]!);
  }
  function lensMove(y: number, ts: number) {
    if (!on || ext >= 0) return lensEnter(y, ts);
    const yy = clamp(y, 0, G.h);
    speed = speed * 0.5 + (Math.abs(yy - lastY) / Math.max(1, ts - lastTs)) * 0.5;
    lastY = yy;
    lastTs = ts;
    lastMove = performance.now();
    py = yy;
  }
  // The card leads: the lens stays locked and glides to its turn.
  function lensFocus(t: number) {
    if (!on) {
      on = true;
      center = pos[t]!;
    }
    ext = t;
    locked = true;
    slowSince = 0;
    amp.to = 1;
    if (t !== sel) {
      sel = t;
      curY.to = pos[t]!;
      announce();
    }
  }
  function lensLeave() {
    on = false;
    ext = -1;
    amp.to = 0;
  }

  function layoutLens() {
    R = G.narrow ? 96 : 120;
    pos = railPositions(days, G.h, G.narrow ? 4 : 5);
    vis.style.cssText = `right:${G.scrollbar + G.edge}px;top:${G.top}px;height:${G.h}px;width:${LENS_W}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(LENS_W * dpr);
    canvas.height = Math.max(1, Math.round((G.h + 1) * dpr));
    // opaque ticks at the ink's alpha, so ticks that overlap never stack into a brighter blot
    canvas.style.cssText = `width:${LENS_W}px;height:${G.h + 1}px;opacity:${inkAlpha}`;
    stride = n > 1 ? Math.max(1, Math.round((DRAW_PITCH * (n - 1)) / Math.max(1, G.h))) : 1;
    rest = document.createElement("canvas");
    rest.width = canvas.width;
    rest.height = canvas.height;
    const r = rest.getContext("2d");
    if (r) {
      r.setTransform(dpr, 0, 0, dpr, 0, 0);
      r.fillStyle = ink;
      const w = TICK_W * REST;
      if (!n) r.fillRect(LENS_W - w, 0, w, G.h);
      for (let t = 0; t < n; t += stride) r.fillRect(LENS_W - w, Math.round(pos[t]! * dpr) / dpr, w, 1);
    }
    drawn = "";
    if (sel >= n) sel = -1;
    if (sel >= 0) {
      snap(curY, pos[sel]!);
      if (ext >= 0) {
        ext = sel;
        center = pos[sel]!;
      }
    }
    if (here >= n) here = -1;
    if (here >= 0) snap(hereY, pos[here]!);
    hereEl.style.visibility = n && here >= 0 ? "visible" : "hidden";
  }

  function drawLens() {
    if (!ctx || !rest) return;
    const dpr = window.devicePixelRatio || 1;
    const zoomed = zoom >= 0.002 && n > 0;
    const lo = center - R;
    const hi = center + R;
    const key = zoomed ? `${lo.toFixed(2)}:${zoom.toFixed(4)}:${amp.x.toFixed(3)}` : "rest";
    if (key === drawn) return;
    drawn = key;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!zoomed) {
      ctx.drawImage(rest, 0, 0);
      return;
    }
    const top = Math.max(0, Math.floor(lo * dpr));
    const bottom = Math.min(canvas.height, Math.ceil((hi + 1) * dpr));
    if (top > 0) ctx.drawImage(rest, 0, 0, canvas.width, top, 0, 0, canvas.width, top);
    if (bottom < canvas.height) ctx.drawImage(rest, 0, bottom, canvas.width, canvas.height - bottom, 0, bottom, canvas.width, canvas.height - bottom);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ink;
    const zN = clamp((zoom - 1) / 3, 0, 1);
    const a = amp.x * (0.45 + 0.55 * zN);
    let lastRow = -Infinity;
    let lastW = 0;
    for (let t = Math.ceil(lowerBound(pos, lo) / stride) * stride; t < n && pos[t]! <= hi; t += stride) {
      const x = (pos[t]! - center) / R;
      const ax = Math.abs(x);
      const bell = 1 - ax * ax;
      const y = Math.round((center + Math.sign(x) * (((zoom + 1) * ax) / (zoom * ax + 1)) * R) * dpr) / dpr;
      const w = TICK_W * (REST + (1 - REST) * a * bell * bell);
      if (y === lastRow && w <= lastW) continue;
      ctx.fillRect(LENS_W - w, y, w, 1);
      lastRow = y;
      lastW = w;
    }
  }

  function lensTick(dt: number, now: number): boolean {
    let busy = step(wake, 16, dt) || false;
    busy = step(amp, 18, dt) || busy;
    busy = step(hereY, 18, dt, 0.05) || busy;
    busy = step(curY, 40, dt, 0.05) || busy;
    if (now - lastMove > 45) speed *= Math.exp(-dt / 0.07);
    let glide = false;
    if (on && ext >= 0 && n) {
      const d = pos[ext]! - center;
      if (RM || Math.abs(d) < 0.05) center = pos[ext]!;
      else {
        center += d * (1 - Math.exp(-20 * dt));
        glide = true;
      }
    } else if (on && n) {
      if (locked) {
        if (speed > 0.6) {
          locked = false;
          slowSince = 0;
        }
      } else if (speed < 0.1) {
        if (!slowSince) slowSince = now;
        else if (now - slowSince > 70) locked = true;
      } else slowSince = 0;
      if (!locked) center += (py - center) * (1 - Math.exp(-30 * dt));
      else {
        const dz = 0.55 * R;
        if (py - center > dz) center = py - dz;
        else if (center - py > dz) center = py + dz;
      }
    }
    const target = on && n ? (locked ? 4 : 1.1) : 0;
    const z0 = zoom;
    zoom += (target - zoom) * (1 - Math.exp(-dt * (target > zoom ? 7 : 12)));
    if (RM || Math.abs(target - zoom) < 0.002) zoom = target;
    if (on && ext < 0 && n) pick();
    const w = Math.max(wake.x, amp.x);
    lensEl.style.opacity = (0.3 + 0.55 * w).toFixed(3);
    lensEl.style.transform = `scaleX(${(1 + 0.6 * w).toFixed(3)})`;
    drawLens();
    hereEl.style.opacity = (0.55 + 0.45 * w).toFixed(3);
    hereEl.style.transform = `translate3d(0,${disp(hereY.x).toFixed(2)}px,0)`;
    curEl.style.opacity = (n ? amp.x : 0).toFixed(3);
    curEl.style.transform = `translate3d(0,${disp(curY.x).toFixed(2)}px,0)`;
    const settling = Math.abs(zoom - z0) > 1e-4 || (on && ext < 0 && !locked && n > 0) || speed > 0.002 || glide;
    return busy || settling;
  }

  const op = spring();
  const so = spring();
  const bs = spring();
  const cy = spring();
  const sx = spring();
  let PW = 0;
  let RH = 32;
  let HH = 26;
  let WH = 0;
  let CH = 0;
  let cx = 0;
  let wordsW = 0;
  let latestUp = false;
  let pill: number | null | undefined = null;
  let aimY = 0;
  let cl: CardLayout = cardLayout([], 32, 26);
  let live = false;
  let csel = -1;
  let cmode: "follow" | "hover" | "touch" = "follow";
  let acc = 0;
  let fling: { from: number; to: number; t0: number; tau: number } | null = null;
  let tp: Touch | null = null;
  let written: Record<string, string> = {};
  const fitted = new Map<number, string>();
  const dayText = new Map<number, string>();
  let measureCtx: CanvasRenderingContext2D | null = null;
  const widths = new Map<string, number>();
  const measure = (text: string) => {
    let w = widths.get(text);
    if (w === undefined) {
      w = measureCtx?.measureText(text).width ?? 0;
      widths.set(text, w);
    }
    return w;
  };
  const lastSlot = () => HH + (VISIBLE - 1) * RH;
  const rubber = (d: number) => 110 * (1 - Math.exp(-d / 200));
  const nearestRow = (y: number) => rowAt(cl.rowY, RH, y);
  const put = (key: string, value: string, write: (value: string) => void) => {
    if (written[key] !== value) {
      written[key] = value;
      write(value);
    }
  };

  function pickAt(t: number) {
    if (t === csel) return;
    if (touch && csel >= 0 && cl.dayOf[t] !== cl.dayOf[csel]) hapticTick();
    csel = t;
    lensFocus(t);
  }
  function aimStrip() {
    so.to = cl.rowY[csel]! - bs.to;
    if (op.x < 0.03 || RM) {
      snap(so, so.to);
      return;
    }
    const d = so.to - so.x;
    if (Math.abs(d) > 2.5 * RH) {
      so.x = so.to - Math.sign(d) * 1.2 * RH;
      so.v = 0;
    }
  }
  const pickBand = () => pickAt(nearestRow(so.x + bs.x + RH / 2));
  // Momentum that comes to rest with a turn in the band.
  function flingTo(v: number) {
    const lo = cl.rowY[0]! - bs.to;
    const hi = cl.rowY[n - 1]! - bs.to;
    const end = clamp(so.x + (RM ? 0 : v) * FLING_MS, lo, hi);
    const to = cl.rowY[nearestRow(end + bs.to + RH / 2)]! - bs.to;
    if (RM) {
      snap(so, to);
      fling = null;
      pickBand();
      return;
    }
    fling = { from: so.x, to, t0: performance.now(), tau: Math.abs(v) < 0.05 ? 110 : FLING_MS };
  }

  function layoutCard() {
    RH = touch ? 40 : 32;
    HH = touch ? 28 : 26;
    PW = Math.min(touch ? 296 : 320, G.width - (touch ? 80 : 70));
    WH = HH + VISIBLE * RH + HH;
    CH = WH + PAD * 2;
    const gap = touch ? 56 : 28;
    cx = G.railX - gap - PW;
    pill = latestUp ? undefined : null;
    measureCtx ??= document.createElement("canvas").getContext("2d");
    widths.clear();
    if (measureCtx) measureCtx.font = `400 11.5px ${font}`;
    const timeW = Math.ceil(measure("00:00")) + 2;
    widths.clear();
    if (measureCtx) measureCtx.font = `400 13px ${font}`;
    wordsW = PW - 18 - 14 - 10 - timeW - 2;
    card.style.cssText = `width:${PW}px;--rh:${RH}px;--hh:${HH}px;--tw:${timeW}px;transform-origin:100% 50%`;
    win.style.height = `${WH}px`;
    heads.style.height = `${WH}px`;
    cl = cardLayout(days, RH, HH);
    fitted.clear();
    dayText.clear();
    written = {};
    for (const row of rows) {
      row.turn = -1;
      row.y = "";
      row.el.style.transform = "translate3d(0,-999px,0)";
    }
    for (const head of headRows) {
      head.day = -1;
      head.y = "";
      head.el.style.transform = "translate3d(0,-999px,0)";
    }
    if (csel >= n) csel = -1;
    if (csel >= 0) {
      snap(bs, clamp(bs.to, HH, lastSlot()));
      so.to = cl.rowY[csel]! - bs.to;
      snap(so, so.to);
    }
  }
  function cardOpen(m: "follow" | "touch") {
    if (!live) openedAt = performance.now();
    if (!cardFits()) return;
    if (m === "follow") {
      fling = null;
      tp = null;
      acc = 0;
    }
    cmode = m;
    live = true;
    card.classList.add("live");
    op.to = 1;
    sx.to = 0;
    if (op.x < 0.03) snap(sx, 0);
  }
  function cardClose() {
    live = false;
    cmode = "follow";
    fling = null;
    tp = null;
    acc = 0;
    card.classList.remove("live");
    op.to = 0;
  }
  // The first card on screen costs the GPU a one-time raster and shader compile (~100 ms); pay it faintly before the pointer arrives.
  function prewarm(k = 0) {
    if (live || op.x > 0.005 || !enabled || k >= WARM_FRAMES) {
      written = {};
      kick();
      return;
    }
    card.style.visibility = "visible";
    card.style.opacity = k % 2 ? "0.02" : "0.03";
    card.style.transform = `translate3d(${cx}px,${((G.height - CH) / 2).toFixed(1)}px,0)`;
    requestAnimationFrame(() => prewarm(k + 1));
  }
  // The Jump to latest pill sits at the transcript's foot; read once each time it shows.
  function pillTop(): number {
    if (pill === undefined) {
      const el = zone.querySelector<HTMLElement>("[data-jump-latest]");
      const rect = el?.getBoundingClientRect();
      // offsetTop, not the rect: the pill pops in from a few px lower
      pill = el && rect && cx < rect.right - box.left + 8 && cx + PW > rect.left - box.left - 8 ? el.offsetTop - host.offsetTop : null;
    }
    return pill ?? Infinity;
  }
  // a short transcript (phone keyboard up, landscape) has no room for the card, which would cover the composer
  const cardFits = () => Math.min(G.height, pillTop() - 2) - CH - 6 >= 6;
  // Follow: the card sits beside the pointer and the picked turn sits in the band next to it.
  function cardAim(y: number) {
    aimY = y;
    if (live && !cardFits()) return closeAll();
    cy.to = clamp(y - PAD - HH - (VISIBLE * RH) / 2, 6, Math.max(6, Math.min(G.height, pillTop() - 2) - CH - 6));
    bs.to = clamp(y - cy.to - PAD - RH / 2, HH, lastSlot());
    if (op.x < 0.03 || RM) {
      snap(cy, cy.to);
      snap(bs, bs.to);
    }
    if (csel >= 0) aimStrip();
  }
  function cardFollow(t: number) {
    if (t >= 0 && t !== csel) {
      csel = t;
      aimStrip();
    }
  }
  function cardHover(clientY: number) {
    cmode = "hover";
    const s = so.to;
    const yw = clientY - box.top - cy.x - PAD;
    let t = nearestRow(yw + s);
    while (t < n - 1 && cl.rowY[t]! - s < HH - 1) t++;
    while (t > 0 && cl.rowY[t]! - s > lastSlot() + 1) t--;
    bs.to = cl.rowY[t]! - s;
    if (RM) snap(bs, bs.to);
    pickAt(t);
  }
  // Wheel or trackpad: the next turn slides in under the pointer and the band stays put.
  function cardWheel(dy: number, deltaMode: number) {
    if (cmode !== "hover" || csel < 0) return;
    acc += dy * (deltaMode === 1 ? 33 : deltaMode === 2 ? 600 : 1);
    const k = Math.trunc(acc / NOTCH);
    if (!k) return;
    acc -= k * NOTCH;
    const t = clamp(csel + k, 0, n - 1);
    if (t === csel) {
      acc = 0;
      return;
    }
    so.to += cl.rowY[t]! - cl.rowY[csel]!;
    if (RM) snap(so, so.to);
    pickAt(t);
  }
  function cardDown(e: PointerEvent) {
    const moving = !!fling && Math.abs(fling.to - so.x) / fling.tau > 0.06;
    fling = null;
    snap(so, so.x);
    tp = { id: e.pointerId, x0: e.clientX, y0: e.clientY, s0: so.x, t0: e.timeStamp, axis: "", stop: moving, pts: [[e.timeStamp, e.clientX, e.clientY]] };
    try {
      card.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  }
  function cardMove(e: PointerEvent) {
    if (!tp || e.pointerId !== tp.id) return;
    tp.pts.push([e.timeStamp, e.clientX, e.clientY]);
    while (tp.pts.length > 2 && e.timeStamp - tp.pts[0]![0] > 90) tp.pts.shift();
    if (!tp.axis) {
      if (Math.hypot(e.clientX - tp.x0, e.clientY - tp.y0) < 8) return;
      tp.axis = Math.abs(e.clientY - tp.y0) >= Math.abs(e.clientX - tp.x0) ? "y" : "x";
      tp.x0 = e.clientX;
      tp.y0 = e.clientY;
      tp.s0 = so.x;
      return;
    }
    if (tp.axis === "y") {
      const lo = cl.rowY[0]! - bs.to;
      const hi = cl.rowY[n - 1]! - bs.to;
      let s = tp.s0 - (e.clientY - tp.y0);
      if (s < lo) s = lo - rubber(lo - s);
      else if (s > hi) s = hi + rubber(s - hi);
      snap(so, s);
      pickBand();
    } else {
      const d = e.clientX - tp.x0;
      snap(sx, d > 0 ? d : -0.3 * rubber(-d));
    }
  }
  // A turn to jump to, "close", or -1.
  function cardUp(e: PointerEvent, cancel: boolean): number | "close" {
    if (!tp || e.pointerId !== tp.id) return -1;
    const p = tp;
    const a = p.pts[0]!;
    const z = p.pts[p.pts.length - 1]!;
    const span = z[0] - a[0];
    const fresh = span > 6 && e.timeStamp - z[0] < 70;
    tp = null;
    if (p.axis === "x") {
      const vx = fresh ? (z[1] - a[1]) / span : 0;
      if (!cancel && (sx.x > 64 || (vx > 0.45 && sx.x > 16))) {
        sx.to = PW * 0.55;
        return "close";
      }
      sx.to = 0;
      return -1;
    }
    if (p.axis === "y") {
      flingTo(fresh && !cancel ? -(z[2] - a[2]) / span : 0);
      return -1;
    }
    if (cancel || p.stop || e.timeStamp - p.t0 > 600) {
      flingTo(0);
      return -1;
    }
    const yw = e.clientY - box.top - cy.x - PAD;
    const ys = yw + so.x;
    if (yw < HH || ys < cl.rowY[0]! - 4 || ys > cl.rowY[n - 1]! + RH + 4) return -1;
    const t = nearestRow(ys);
    bs.to = cl.rowY[t]! - so.x;
    pickAt(t);
    return t;
  }

  function wordsOf(t: number) {
    let text = fitted.get(t);
    if (text === undefined) {
      text = fitWords(turns!.words[t] ?? "", wordsW, measure);
      fitted.set(t, text);
    }
    return text;
  }
  function headText(day: number) {
    let text = dayText.get(day);
    if (text === undefined) {
      text = hooks.day(turns!.at[cl.headTurn[day]!]!);
      dayText.set(day, text);
    }
    return text;
  }

  function cardTick(dt: number, now: number): boolean {
    let busy = step(op, 22, dt) || false;
    busy = step(cy, 26, dt, 0.05) || busy;
    busy = step(bs, 40, dt, 0.05) || busy;
    busy = step(sx, 24, dt, 0.05) || busy;
    if (fling) {
      const e = Math.exp(-Math.max(0, now - fling.t0) / fling.tau);
      const s = fling.to + (fling.from - fling.to) * e;
      snap(so, s);
      if (Math.abs(s - fling.to) < 1.5) {
        so.to = fling.to;
        fling = null;
      }
      busy = true;
      if (cmode === "touch") pickBand();
    } else busy = step(so, 30, dt, 0.05) || busy;
    if (!live && op.x < 0.01) snap(sx, 0);
    const o = op.x;
    const shown = o > 0.005 || live;
    put("vis", shown ? "visible" : "hidden", (v) => (card.style.visibility = v));
    if (!shown || !n) return busy;
    const fade = 1 - clamp(sx.x / 240, 0, 0.75);
    put("op", (o * fade).toFixed(3), (v) => (card.style.opacity = v));
    put("tf", `translate3d(${(cx + sx.x + (1 - o) * 10).toFixed(1)}px,${cy.x.toFixed(1)}px,0) scale(${(0.97 + 0.03 * o).toFixed(4)})`, (v) => (card.style.transform = v));
    put("bs", bs.x.toFixed(1), (v) => (band.style.transform = `translate3d(0,${v}px,0)`));
    const top = so.x;
    // pooled rows: only the turns in view hold one
    const first = Math.max(0, lowerBound(cl.rowY, top - RH));
    let last = first;
    while (last < n && cl.rowY[last]! < top + WH) last++;
    for (const row of rows) {
      if (row.turn >= 0 && (row.turn < first || row.turn >= last)) {
        row.turn = -1;
        row.y = "";
        row.el.style.transform = "translate3d(0,-999px,0)";
      }
    }
    for (let t = first; t < last; t++) {
      let row = rows.find((r) => r.turn === t);
      if (!row) {
        row = rows.find((r) => r.turn < 0);
        if (!row) break;
        row.turn = t;
        row.el.dataset.turn = String(t);
        row.time.textContent = hooks.time(turns!.at[t]!);
        row.words.textContent = wordsOf(t);
      }
      const y = (cl.rowY[t]! - top).toFixed(1);
      if (row.y !== y) {
        row.y = y;
        row.el.style.transform = `translate3d(0,${y}px,0)`;
      }
    }
    // A header only for a day with a row in view: the top day's stays pinned while its rows show below the slot.
    let k = -1;
    let lo = 0;
    let hi = cl.headY.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cl.headY[mid]! <= top) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const want = new Map<number, number>();
    const end = k + 1 < cl.headY.length ? cl.headY[k + 1]! : cl.length;
    if (k >= 0 && end - top - RH / 2 >= HH) want.set(k, 0);
    for (let i = k + 1; i < cl.headY.length && cl.headY[i]! - top + HH + RH / 2 < WH; i++) want.set(i, cl.headY[i]! - top);
    for (const head of headRows) {
      if (head.day >= 0 && !want.has(head.day)) {
        head.day = -1;
        head.y = "";
        head.el.style.transform = "translate3d(0,-999px,0)";
      }
    }
    for (const [day, y] of want) {
      let head = headRows.find((h) => h.day === day);
      if (!head) {
        head = headRows.find((h) => h.day < 0);
        if (!head) break;
        head.day = day;
        head.el.textContent = headText(day);
      }
      const ys = y.toFixed(1);
      if (head.y !== ys) {
        head.y = ys;
        head.el.style.transform = `translate3d(0,${ys}px,0)`;
      }
    }
    return busy;
  }

  let raf = 0;
  let lastT = 0;
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  function frame(now: number) {
    raf = 0;
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    let busy = lensTick(dt, now);
    // The lens and the card point at the same turn; the rail leads while the pointer or thumb is on it.
    if (live && cmode === "follow" && sel >= 0 && sel !== csel) {
      if (touch && csel >= 0 && cl.dayOf[sel] !== cl.dayOf[csel]) hapticTick();
      cardFollow(sel);
    }
    busy = cardTick(dt, now) || busy;
    if (busy) raf = requestAnimationFrame(frame);
    else lastT = 0;
  }

  function announce() {
    if (!n || sel < 0) return;
    hit.setAttribute("aria-valuenow", String(sel + 1));
    hit.setAttribute("aria-valuetext", hooks.valueText(turns!.at[sel]!, turns!.words[sel] ?? ""));
  }
  function apply(next: Turns) {
    turns = next;
    version = next.version;
    n = next.ids.length;
    days = dayNumbers(next.at);
    idIndex = null;
    hit.setAttribute("aria-valuemin", "1");
    hit.setAttribute("aria-valuemax", String(Math.max(1, n)));
    layoutLens();
    layoutCard();
    updateHere();
    kick();
  }
  // The first approach loads the index; a held one only needs the turns that arrived since.
  function approach(): boolean {
    if (turns) {
      const grew = hooks.catchUp(turns);
      if (!turns.stale) {
        if (grew || turns.version !== version) apply(turns);
        return true;
      }
    }
    load();
    return false;
  }
  // A stale index stays on screen until the fresh one lands.
  function load() {
    if (loading || performance.now() - failedAt < RETRY_MS) return;
    loading = true;
    const forThread = thread;
    void hooks.turns().then((next) => {
      if (forThread !== thread) return;
      loading = false;
      if (!next) {
        failedAt = performance.now();
        return;
      }
      apply(next);
      if (mode === "rail" || mode === "drag") {
        lensEnter(py, performance.now());
        cardOpen("follow");
        cardAim(G.top + clamp(py, 0, G.h));
        kick();
      } else if (mode === "key") keyFocus();
    });
  }

  let hereRaf = 0;
  const turnOf = (row: Element | null) => {
    const id = row instanceof HTMLElement ? row.dataset.mid : undefined;
    return id ? (idIndex!.get(id) ?? -1) : -1;
  };
  function topTurn(): number {
    if (!idIndex) idIndex = new Map(turns!.ids.map((id, t) => [id, t]));
    const log = scroller.firstElementChild;
    const x = box.left + (G.width - G.scrollbar) / 2;
    for (const dy of [24, 48, 80, 120]) {
      let row = document.elementFromPoint(x, box.top + dy);
      if (!log || !row || row === log || !log.contains(row)) continue;
      // tool steps nest inside their run; the transcript's own rows are the log's children
      while (row.parentElement !== log) row = row.parentElement!;
      // the turn a row belongs to is the nearest turn row above it, or the one before the next turn
      let r: Element | null = row;
      for (let k = 0; r && k < 400; k++, r = r.previousElementSibling) {
        const t = turnOf(r);
        if (t >= 0) return t;
      }
      r = row.nextElementSibling;
      for (let k = 0; r && k < 400; k++, r = r.nextElementSibling) {
        const t = turnOf(r);
        if (t >= 0) return Math.max(0, t - 1);
      }
      break;
    }
    return here;
  }
  function updateHere() {
    hereRaf = 0;
    if (!n || !enabled) return;
    const t = following ? n - 1 : topTurn();
    if (t >= 0 && t !== here) {
      here = t;
      hereY.to = pos[t]!;
      if (hereEl.style.visibility !== "visible") {
        snap(hereY, pos[t]!);
        hereEl.style.visibility = "visible";
      }
      kick();
    }
  }
  const onScroll = () => {
    if (n && !hereRaf) hereRaf = requestAnimationFrame(updateHere);
    // phone: the rail wakes while the reader scrolls, never while a reply streams in
    if (touch && !following && enabled) {
      wake.to = 1;
      kick();
      clearTimeout(sleepTimer);
      sleepTimer = window.setTimeout(() => {
        wake.to = 0;
        kick();
      }, 1200);
    }
  };

  function measureFrame(force = false) {
    if (!enabled) {
      unmeasured = true;
      return;
    }
    unmeasured = false;
    const wasTouch = touch;
    touch = hoverless.matches;
    const sb = scroller.offsetWidth - scroller.clientWidth;
    const next = railFrame(scroller.offsetWidth, scroller.clientHeight, sb);
    if (!force && touch === wasTouch && next.width === G.width && next.height === G.height && next.scrollbar === G.scrollbar) return;
    G = next;
    host.style.height = `${G.height}px`;
    refreshBox();
    hit.style.cssText = `right:${G.scrollbar}px;top:${G.top - 8}px;height:${G.h + 16}px;width:${G.hitWidth}px`;
    layoutLens();
    layoutCard();
    if (live) cardAim(aimY);
    kick();
  }
  function restyle() {
    const probe = getComputedStyle(vis);
    ink = probe.getPropertyValue("--color-ink-secondary").trim() || probe.color;
    const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (px) {
      px.fillStyle = ink;
      px.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = px.getImageData(0, 0, 1, 1).data;
      ink = `rgb(${red} ${green} ${blue})`;
      inkAlpha = (alpha ?? 255) / 255;
    }
    font = getComputedStyle(card).fontFamily;
    measureFrame(true);
  }

  const railOpen = (y: number, ts: number) => {
    clearTimeout(leaveTimer);
    lensEnter(y, ts);
    cardOpen("follow");
    cardAim(G.top + clamp(y, 0, G.h));
    kick();
  };
  const railMove = (y: number, ts: number) => {
    lensMove(y, ts);
    cardAim(G.top + clamp(y, 0, G.h));
    kick();
  };
  function closeAll() {
    clearTimeout(leaveTimer);
    clearTimeout(intentTimer);
    intentTimer = 0;
    mode = "idle";
    dragId = null;
    cardClose();
    lensLeave();
    kick();
  }
  const closeSoon = () => {
    clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(closeAll, 160);
  };
  // The ends land on the first and the latest message.
  function go(t: number) {
    const target = turns;
    closeAll();
    if (!target || t < 0) return;
    if (t >= target.ids.length - 1) hooks.latest();
    else hooks.jump(t === 0 ? (target.first ?? target.ids[0]!) : target.ids[t]!);
  }

  const railIntent = () => {
    clearTimeout(intentTimer);
    intentTimer = 0;
    mode = "rail";
    if (approach()) railOpen(py, performance.now());
  };
  // A mouse crossing the strip for the chat opens nothing: sideways travel restarts the wait, up or down does not.
  function aim(e: PointerEvent) {
    const dx = Math.abs(e.clientX - ax);
    if (intentTimer && (dx <= INTENT_PX || dx * 2 <= Math.abs(e.clientY - ay))) return;
    ax = e.clientX;
    ay = e.clientY;
    clearTimeout(intentTimer);
    intentTimer = window.setTimeout(railIntent, INTENT_MS);
  }
  const onHitEnter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    refreshBox();
    py = clamp(pointY(e), 0, G.h);
    if (!live) return aim(e);
    mode = "rail";
    if (approach()) railOpen(pointY(e), e.timeStamp);
  };
  const onHitMove = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      py = clamp(pointY(e), 0, G.h);
      if (mode !== "rail" && !live) return aim(e);
      if (!n) return;
      if (mode === "rail") railMove(pointY(e), e.timeStamp);
      else {
        mode = "rail";
        railOpen(pointY(e), e.timeStamp);
      }
    } else if (e.pointerId === dragId) {
      py = clamp(pointY(e), 0, G.h);
      if (n) railMove(pointY(e), e.timeStamp);
    }
  };
  const onHitLeave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(intentTimer);
    intentTimer = 0;
    if (mode === "rail") closeSoon();
  };
  const onHitDown = (e: PointerEvent) => {
    lastPT = e.pointerType;
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    refreshBox();
    try {
      hit.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    dragId = e.pointerId;
    mode = "drag";
    py = clamp(pointY(e), 0, G.h);
    if (approach()) railOpen(pointY(e), e.timeStamp);
  };
  // Lift: the card stays open on that turn and the chat does not move yet.
  const onHitUp = (e: PointerEvent) => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    if (!n || !live) {
      closeAll();
      return;
    }
    mode = "open";
    cardFollow(sel);
    cmode = "touch";
    snap(bs, bs.to);
    lensFocus(csel);
    kick();
  };
  const onHitCancel = (e: PointerEvent) => {
    if (e.pointerId === dragId) closeAll();
  };
  // A click just after the card opens was likely meant for what lay under it.
  const onHitClick = () => {
    if (lastPT !== "mouse") return;
    if (mode === "idle") railIntent();
    else if (mode === "rail" && sel >= 0 && performance.now() - openedAt >= GUARD_MS) go(sel);
  };
  // Wheel over the rail scrolls the chat, as wheel over the transcript does.
  const onHitWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollBy({ top: e.deltaY * scale });
    hooks.wheel(e.deltaY);
  };

  const onCardDown = (e: PointerEvent) => {
    lastPT = e.pointerType;
    if (e.pointerType === "mouse" || mode !== "open") return;
    e.preventDefault();
    cardDown(e);
    kick();
  };
  const onCardMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") {
      if (mode === "open") {
        cardMove(e);
        kick();
      }
      return;
    }
    if (!live || mode === "key") return;
    clearTimeout(leaveTimer);
    mode = "card";
    cardHover(e.clientY);
    kick();
  };
  const cardLift = (e: PointerEvent, cancel: boolean) => {
    if (e.pointerType === "mouse" || mode !== "open") return;
    const r = cardUp(e, cancel);
    if (r === "close") closeAll();
    else if (r >= 0) {
      go(r);
      swallowAt = e.timeStamp;
    }
    kick();
  };
  const onCardUp = (e: PointerEvent) => cardLift(e, false);
  const onCardCancel = (e: PointerEvent) => cardLift(e, true);
  const onCardLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && mode === "card") closeSoon();
  };
  const onCardWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!live || mode === "open" || mode === "drag" || mode === "key") return;
    clearTimeout(leaveTimer);
    if (mode !== "card") {
      mode = "card";
      cardHover(e.clientY);
    }
    cardWheel(e.deltaY, e.deltaMode);
    kick();
  };
  const onCardClick = () => {
    if (lastPT === "mouse" && mode === "card" && csel >= 0 && performance.now() - openedAt >= GUARD_MS) go(csel);
  };
  // A click on the rail or the card leaves focus where it was, so the composer keeps it.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  // Even under touch-action: none, a lift with speed starts a browser fling that eats the next tap.
  const ownTouch = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  };
  // A tap outside the open card only closes it; its click goes nowhere, like a row tap's.
  const onDocDown = (e: PointerEvent) => {
    swallowAt = -1;
    if (mode !== "open" || e.pointerType === "mouse" || (e.target instanceof Node && (card.contains(e.target) || hit.contains(e.target)))) return;
    closeAll();
    // Jump to latest still jumps
    if (!(e.target instanceof Element && e.target.closest("[data-jump-latest]"))) swallowAt = e.timeStamp;
  };
  const onDocClick = (e: MouseEvent) => {
    if (swallowAt < 0) return;
    const fresh = e.timeStamp - swallowAt < 800;
    swallowAt = -1;
    if (fresh) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // The rail wakes as the pointer nears it, and the first approach loads the turns.
  const zone = host.parentElement ?? host;
  const onZoneMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || !enabled) return;
    const x = pointX(e);
    const y = e.clientY - box.top;
    const dx = G.railX - 10 - x;
    // the composer below shares this box
    const w = y < 0 || y > G.height ? 0 : 1 - clamp((dx - 8) / 150, 0, 1);
    if (w > 0) {
      approach();
      if (!warmed) {
        warmed = true;
        prewarm();
      }
    }
    if (w !== wake.to) {
      wake.to = w;
      kick();
    }
  };
  const onZoneEnter = () => refreshBox();
  const onZoneLeave = () => {
    if (wake.to !== 0) {
      wake.to = 0;
      kick();
    }
  };

  function keyTo(t: number) {
    if (!n) return;
    t = clamp(t, 0, n - 1);
    lensFocus(t);
    cardFollow(t);
    cardAim(G.top + pos[t]!);
    kick();
  }
  function keyFocus() {
    if (!n) return;
    mode = "key";
    cardOpen("follow");
    keyTo(sel >= 0 ? sel : here >= 0 ? here : n - 1);
  }
  const onFocus = () => {
    if (!hit.matches(":focus-visible")) return;
    mode = "key";
    if (approach()) keyFocus();
  };
  const onBlur = () => {
    if (mode === "key") closeAll();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const by = KEY_STEP.get(e.key);
    if (by !== undefined || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      if (mode !== "key") keyFocus();
      const from = sel >= 0 ? sel : n - 1;
      keyTo(e.key === "Home" ? 0 : e.key === "End" ? n - 1 : from + by!);
    } else if ((e.key === "Enter" || e.key === " ") && mode === "key" && sel >= 0) {
      e.preventDefault();
      go(sel);
    } else if (e.key === "Escape" && mode === "key") {
      e.preventDefault();
      closeAll();
    }
  };

  hit.addEventListener("pointerenter", onHitEnter);
  hit.addEventListener("pointermove", onHitMove);
  hit.addEventListener("pointerleave", onHitLeave);
  hit.addEventListener("pointerdown", onHitDown);
  hit.addEventListener("pointerup", onHitUp);
  hit.addEventListener("pointercancel", onHitCancel);
  hit.addEventListener("click", onHitClick);
  hit.addEventListener("mousedown", keepFocus);
  hit.addEventListener("wheel", onHitWheel, { passive: false });
  hit.addEventListener("touchstart", ownTouch, { passive: false });
  hit.addEventListener("focus", onFocus);
  hit.addEventListener("blur", onBlur);
  hit.addEventListener("keydown", onKey);
  card.addEventListener("pointerdown", onCardDown);
  card.addEventListener("pointermove", onCardMove);
  card.addEventListener("pointerup", onCardUp);
  card.addEventListener("pointercancel", onCardCancel);
  card.addEventListener("pointerleave", onCardLeave);
  card.addEventListener("mousedown", keepFocus);
  card.addEventListener("wheel", onCardWheel, { passive: false });
  card.addEventListener("touchstart", ownTouch, { passive: false });
  card.addEventListener("click", onCardClick);
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("click", onDocClick, true);
  zone.addEventListener("pointermove", onZoneMove, { passive: true });
  zone.addEventListener("pointerenter", onZoneEnter);
  zone.addEventListener("pointerleave", onZoneLeave);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  let resizeRaf = 0;
  const resize = new ResizeObserver(() => {
    if (!enabled) {
      unmeasured = true;
      return;
    }
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => measureFrame());
  });
  resize.observe(scroller);
  const onFonts = () => {
    if (n) {
      layoutCard();
      kick();
    }
  };
  document.fonts?.addEventListener?.("loadingdone", onFonts);
  const onHover = () => measureFrame(true);
  hoverless.addEventListener?.("change", onHover);

  return {
    setThread(threadId) {
      if (threadId === thread) return;
      thread = threadId;
      // a rail nobody touched has nothing to undo, so a bot switch costs nothing
      const used = n > 0 || mode !== "idle" || live;
      if (used) closeAll();
      turns = null;
      version = -1;
      n = 0;
      days = new Int32Array(0);
      loading = false;
      failedAt = -Infinity;
      here = -1;
      sel = -1;
      csel = -1;
      idIndex = null;
      hit.removeAttribute("aria-valuenow");
      hit.removeAttribute("aria-valuetext");
      hit.setAttribute("aria-valuemax", "1");
      if (used && G.height) {
        layoutLens();
        layoutCard();
        kick();
      }
    },
    setLatestShown(shown) {
      latestUp = shown;
      pill = shown ? undefined : null;
      if (live) {
        cardAim(aimY);
        kick();
      }
    },
    setFollowing(next) {
      following = next;
      if (n && !hereRaf) hereRaf = requestAnimationFrame(updateHere);
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      host.hidden = !next;
      if (!next) closeAll();
      else if (!ink || unmeasured) {
        // after the frame that shows the chat, not inside the switch
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => (ink ? measureFrame() : restyle()));
      }
    },
    restyle() {
      hit.setAttribute("aria-label", hooks.label());
      if (enabled) restyle();
      else ink = "";
    },
    liveChanged() {
      if (!turns || !(live || wake.to > 0)) return;
      const grew = hooks.catchUp(turns);
      if (turns.stale) load();
      else if (grew) apply(turns);
    },
    destroy() {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(hereRaf);
      cancelAnimationFrame(resizeRaf);
      clearTimeout(leaveTimer);
      clearTimeout(sleepTimer);
      clearTimeout(intentTimer);
      resize.disconnect();
      reducedQuery.removeEventListener?.("change", onReduced);
      hoverless.removeEventListener?.("change", onHover);
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("click", onDocClick, true);
      document.fonts?.removeEventListener?.("loadingdone", onFonts);
      zone.removeEventListener("pointermove", onZoneMove);
      zone.removeEventListener("pointerenter", onZoneEnter);
      zone.removeEventListener("pointerleave", onZoneLeave);
      scroller.removeEventListener("scroll", onScroll);
      host.replaceChildren();
    },
  };
}
