import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { ArrowDown, ArrowUp, Lock, Square } from "lucide-react";
import type { ModelSelection } from "@/state/store";
import { pickerEfforts, pickerModels, selectPickerEffort, selectPickerModel, type PickerRow } from "@/lib/cross-model-picker";
import { DIAL_DIGITS, dialFind, dialPrice, dialScore, dialShift, dialSource, dialStep, dialTier, type DialStat } from "@/lib/model-dial";
import { formatUsd, pickerPrice } from "@/lib/model-index";
import { MODEL_INDEX_AS_OF } from "../../shared/model-index-data.ts";
import { engineBadgeText, modelEffortLabel, modelFamilyAccent } from "@/lib/model-chip";
import { PHONE_QUERY, reducedMotion } from "@/lib/phone-swipe";
import { useDialTouch } from "@/lib/use-dial-touch";
import { useI18n } from "@/lib/i18n";
import { ProviderMark } from "./ProviderIcons";
import { needsCli, needsSignIn } from "./EngineSetup";
import "./ModelDial.css";

const DIAL_QUERY = "(min-width: 640px) and (pointer: fine)";
const PHONE_DIAL_QUERY = `${PHONE_QUERY} and (pointer: coarse)`;
const FADE = [1, 0.55, 0.22];
const PHONE_FADE = [1, 0.38];
// Card spacing in the phone layout; ModelDial.css uses the same 62px.
const PHONE_PITCH = 62;
// Overdrive's outer arc: a segment every 12 deg, minus three under the effort label and one under the max pointer.
const RING = Array.from({ length: 30 }, (_, k) => 270 + k * 12).filter((a) => Math.abs(a - 450) > 12 && a !== 366);

const wrap = (n: number, size: number) => ((n % size) + size) % size;
const shortest = (delta: number, size: number) => wrap(delta + Math.floor(size / 2), size) - Math.floor(size / 2);
const point = (r: number, deg: number) => [240 + r * Math.cos(deg * Math.PI / 180), 240 + r * Math.sin(deg * Math.PI / 180)].map((v) => +v.toFixed(2));
const flip = (el: HTMLElement | null, key: string) => { if (el) el.dataset[key] = el.dataset[key] === "1" ? "0" : "1"; };

function sector(r0: number, r1: number, a0: number, a1: number) {
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = point(r1, a0);
  const [x1, y1] = point(r1, a1);
  const [x2, y2] = point(r0, a1);
  const [x3, y3] = point(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

const SQUIGGLE = Array.from({ length: 24 }, (_, k) => ` Q${k * 10 + 6} ${5 + (k % 2 ? 1 : -1) * [4.2, 3.2, 4.6, 3.6][k % 4]!} ${k * 10 + 11} 5`).join("");

function useMatch(media: string, enabled: boolean): boolean {
  const [fits, setFits] = useState(() => enabled && (globalThis.window?.matchMedia?.(media).matches ?? false));
  useEffect(() => {
    const query = enabled ? window.matchMedia?.(media) : undefined;
    if (!query) return setFits(false);
    const change = () => setFits(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [media, enabled]);
  return fits;
}

export const useModelDialFits = (enabled: boolean) => useMatch(`${DIAL_QUERY}, ${PHONE_DIAL_QUERY}`, enabled);

const fontWarm = new WeakMap<FontFaceSet, { claims: Set<symbol>; cancel?: () => void; done?: boolean }>();

// The first open otherwise fetches the mono font mid-layout; desktop loads it once per page at idle instead.
export function useDialFontWarm(enabled: boolean, open: boolean) {
  const desktop = useMatch(DIAL_QUERY, enabled);
  useEffect(() => {
    const fonts = globalThis.document?.fonts;
    if (!desktop || !fonts?.load) return;
    const warm = fontWarm.get(fonts) ?? { claims: new Set<symbol>() };
    fontWarm.set(fonts, warm);
    if (open) warm.done = true;
    if (warm.done) return warm.cancel?.();
    const claim = Symbol();
    warm.claims.add(claim);
    if (!warm.cancel) {
      let idle = 0;
      const run = () => {
        warm.cancel = undefined;
        if (warm.done || !window.matchMedia(DIAL_QUERY).matches || document.querySelector("[data-model-picker-content]")) return;
        warm.done = true;
        for (const weight of [400, 500, 600]) fonts.load(`${weight} 11px "JetBrains Mono"`).catch(() => undefined);
      };
      const timer = window.setTimeout(() => {
        if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 3000 });
        else run();
      }, 2000);
      warm.cancel = () => {
        clearTimeout(timer);
        if (idle) window.cancelIdleCallback(idle);
        warm.cancel = undefined;
      };
    }
    return () => {
      warm.claims.delete(claim);
      if (!warm.claims.size) warm.cancel?.();
    };
  }, [desktop, open]);
}

export type ModelDialHandle = { key: (event: ReactKeyboardEvent) => boolean };

type ModelDialProps = {
  rows: PickerRow[];
  draft: ModelSelection;
  canCommit: (selection: ModelSelection) => boolean;
  onDraft: (next: ModelSelection) => void;
  onSave: (next?: ModelSelection, fromKeyboard?: boolean) => void;
  handle: Ref<ModelDialHandle | null>;
  stageRef: Ref<HTMLDivElement>;
  bindingsId: string;
};

function Odometer({ value, int, dec }: { value: number | undefined; int: number; dec: number }) {
  const { t } = useI18n();
  const digits = value == null ? "" : value.toFixed(dec).replace(".", "").padStart(int + dec, " ");
  const strip = (k: number) => (
    <span key={k} className="dg">
      <span className="strip" style={{ "--d": digits[k] === " " || !digits[k] ? 10 : digits[k] } as CSSProperties}>
        {[..."0123456789"].map((d) => <i key={d}>{d}</i>)}<i />
      </span>
    </span>
  );
  return (
    <span className="dial-odo" data-none={value == null || undefined}>
      <span className="sr-only">{value == null ? t("engines.unavailable") : value.toFixed(dec)}</span>
      <span className="cells" aria-hidden>
        {Array.from({ length: int }, (_, k) => strip(k))}
        {dec > 0 && <><span>.</span>{Array.from({ length: dec }, (_, k) => strip(int + k))}</>}
      </span>
      <span className="dash" aria-hidden>-</span>
    </span>
  );
}

export function ModelDial({ rows, draft, canCommit, onDraft, onSave, handle, stageRef, bindingsId }: ModelDialProps) {
  const { t } = useI18n();
  const phone = useMatch(PHONE_DIAL_QUERY, true);
  const models = pickerModels(rows);
  const count = models.length;
  const labOf = models.map((item) => rows.findIndex((row) => row.instance === item.instance));
  const index = Math.max(0, models.findIndex((item) => item.instance.instanceId === draft.instanceId && item.cell.options.some((option) => option.id === draft.model)));
  const item = models[index];
  const lab = labOf[index] ?? 0;
  const efforts = item ? pickerEfforts(item, item.cell) : [];
  const level = efforts.findIndex((option) => option.model ? option.model === draft.model : option.effort === draft.effort);
  const effort = efforts[level];
  const max = effort?.label === "max";
  const locked = (row: PickerRow) => needsCli(row.instance) || needsSignIn(row.instance);
  const labLocked = rows[lab] ? locked(rows[lab]!) : false;
  const pickable = canCommit(draft);
  const accent = modelFamilyAccent(item?.instance.driverKind);
  const step = 360 / Math.max(count, 1);
  const labStep = 360 / Math.max(rows.length, 1);
  const names = models.map((model) => {
    const option = model.cell.options[0]!;
    const contrib = !model.cell.offList && model.cell.options.length === 1 && /-contributor$/i.test(option.id);
    return { name: contrib ? option.label.replace(/\s+contributor$/i, "") : model.cell.label, tag: contrib ? "Contrib" : "" };
  });
  const search = models.map((model, j) => `${model.label} ${names[j]!.name}`);
  const intel = item ? dialScore(draft.model, effort?.effort, "intelligence") : undefined;
  const coding = item ? dialScore(draft.model, effort?.effort, "coding") : undefined;
  const price = item ? dialPrice(draft.model) : undefined;
  const ms = 170;

  // Turn counters only grow, so the bezel and lab ring always take the short way round.
  const track = useRef({ i: index, turn: index, lab, at: 0, lead: 0, labMs: ms });
  if (track.current.i !== index) {
    const delta = shortest(index - track.current.i, count);
    const dir = Math.sign(delta);
    let crossed = 0;
    for (let s = 0, j = track.current.i; s < Math.abs(delta); s++, j = wrap(j + dir, count)) {
      if (labOf[wrap(j + dir, count)] !== labOf[j]) crossed += dir;
    }
    const now = performance.now();
    track.current = { i: index, turn: track.current.turn + delta, lab: track.current.lab + crossed, at: now, lead: now - track.current.at > 250 ? dir : 0, labMs: crossed ? 190 : 170 };
  }
  const { turn, lab: labTurn, lead, labMs } = track.current;

  const [boot, setBoot] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [typed, setTyped] = useState<{ text: string; i: number; on: boolean }>({ text: "", i: -1, on: false });
  const [live, setLive] = useState("");
  const typing = useRef({ text: "", at: 0, timer: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const tile = useRef<HTMLDivElement>(null);
  const barText = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLElement>(null);
  const arcs = useRef<Array<HTMLElement | null>>([]);
  const squiggle = useRef<HTMLSpanElement>(null);
  const intro = useRef<Animation[]>([]);
  const bar = useRef<{ timer: number; anims: Animation[] }>({ timer: 0, anims: [] });
  const ring = useRef({ from: 0, to: 0, start: 0, ms: 0, anims: [] as Animation[] });
  const wave = useRef(0);
  const shown = useRef<{ i?: number; effort?: string; blend?: number }>({});

  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setBoot(false)); });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(bar.current.timer);
      clearTimeout(typing.current.timer);
    };
  }, []);

  useEffect(() => {
    const [width, height] = phone ? [390, 844] : [1440, 900];
    const fit = () => setZoom(Math.min(window.innerWidth / width, window.innerHeight / height));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [phone]);

  const quench = () => {
    intro.current.forEach((anim) => anim.cancel());
    intro.current = [];
  };

  const ease = (x: number, spring: number[]) => {
    if (x >= 1) return 1;
    const at = Math.max(x, 0) * (spring.length - 1);
    const k = Math.floor(at);
    return spring[k]! + (spring[k + 1]! - spring[k]!) * (at - k);
  };

  // The ring is two clipped half-arcs; sampling one eased angle keeps them from splitting mid-sweep.
  const sweep = (deg: number) => {
    const state = ring.current;
    const now = performance.now();
    const duration = reducedMotion() || boot ? 0 : ms;
    // A forced style read; a zero-duration sweep only needs its end pose.
    const spring = duration ? getComputedStyle(stage.current!).getPropertyValue("--spring").match(/\d*\.\d+|\d+/g)?.map(Number) ?? [0, 1] : [0, 1];
    const from = state.from + (state.to - state.from) * ease(state.ms ? (now - state.start) / state.ms : 1, spring);
    Object.assign(state, { from, to: deg, start: now, ms: duration });
    const parts = [(a: number) => Math.min(Math.max(a, 0), 180), (a: number) => Math.min(Math.max(a - 180, 0), 180), (a: number) => a];
    state.anims.forEach((anim) => anim.cancel());
    state.anims = arcs.current.flatMap((el, j) => el?.animate?.(
      duration ? Array.from({ length: 25 }, (_, s) => ({ transform: `rotate(${parts[j]!(from + (deg - from) * ease(s / 24, spring))}deg)` })) : [{ transform: `rotate(${parts[j]!(deg)}deg)` }],
      { duration, fill: "forwards" },
    ) ?? []);
  };

  const typeOut = (from: number) => {
    const text = barText.current!;
    const n = text.textContent!.length;
    const timing = { duration: (n - from) * 19, delay: from ? 0 : 90, easing: `steps(${Math.max(n - from, 1)})`, fill: "backwards" as const };
    const end = timing.delay + timing.duration;
    bar.current.anims.forEach((anim) => anim.cancel());
    bar.current.anims = [
      text.animate?.({ width: [`${from}ch`, `${n}ch`] }, timing),
      caret.current?.animate?.({ opacity: [1, 0, 1, 0], offset: [0, (end + 160) / (end + 480), (end + 320) / (end + 480), 1], easing: "step-end" }, end + 480),
    ].filter((anim): anim is Animation => Boolean(anim));
  };

  useLayoutEffect(() => {
    const moved = shown.current.i !== undefined && shown.current.i !== index;
    const landed = max && shown.current.effort !== "max" && shown.current.i !== undefined;
    const write = () => {
      const text = barText.current!;
      const word = document.createElement("b");
      word.textContent = effort ? modelEffortLabel(effort.label, t) : "-";
      const tail = labLocked && item ? engineBadgeText(item.instance.snapshot, needsCli(item.instance) ? "not-installed" : "sign-in", t)
        : price ? t("model.dial.price", { input: formatUsd(price.input), output: formatUsd(price.output) }) : "";
      text.replaceChildren(`${t("model.dial.effort")} `, word, tail ? ` · ${tail}` : "");
    };
    if (moved) {
      flip(tile.current, "q");
      flip(plane.current, "f");
    }
    const open = plane.current!.hasAttribute("data-open");
    clearTimeout(bar.current.timer);
    if (moved) {
      plane.current!.removeAttribute("data-open");
      bar.current.anims.forEach((anim) => anim.cancel());
    }
    if (reducedMotion() || shown.current.i === undefined) {
      write();
      plane.current!.setAttribute("data-open", "");
    } else if (open && !moved) {
      write();
      typeOut(t("model.dial.effort").length + 1);
    } else {
      bar.current.timer = window.setTimeout(() => {
        write();
        plane.current!.setAttribute("data-open", "");
        typeOut(0);
      }, labMs + 250);
    }
    quench();
    if (landed && !reducedMotion()) overdrive();
    if (intel != null && intel * 3.6 !== ring.current.to) sweep(intel * 3.6);
    if (shown.current.blend !== undefined && price?.blend !== shown.current.blend) {
      wave.current = (wave.current + 14) % 40;
      squiggle.current?.style.setProperty("--wave", `${-wave.current}px`);
      flip(squiggle.current, "w");
    }
    shown.current = { i: index, effort: effort?.label, blend: price?.blend };
    const settle = window.setTimeout(() => setLive(`${item?.label ?? ""} ${names[index]?.name ?? ""}, ${t("model.effort")}: ${effort ? modelEffortLabel(effort.label, t) : "-"}`), 220);
    return () => clearTimeout(settle);
  }, [index, effort?.id, labLocked]);

  // Landing on max: the pointer overshoots, a head races the outer arc round once and a shockwave leaves the logo.
  const overdrive = () => {
    const face = stage.current!;
    const race = (a: number) => 110 + 420 * wrap(a - 32.25, 360) / 360;
    const lit = [...face.querySelectorAll<SVGElement>(".dial-gauge[data-on] .dial-notch .lit")].at(-1);
    const anims = [
      lit?.animate?.({ fill: ["#fff", "var(--hot)"] }, 260),
      face.querySelector(".dial-pointer")?.animate?.({ rotate: ["0deg", "16deg", "-3deg", "0deg"], offset: [0, 0.4, 0.75, 1] }, { duration: 320, easing: "ease-out" }),
      ...[...face.querySelectorAll(".dial-overdrive path")].map((seg, k) => seg.animate?.({ opacity: [0, 1] }, { duration: 0, delay: race(RING[k]!), fill: "backwards" })),
      face.querySelector(".dial-overdrive .head")?.animate?.({ rotate: ["27.5deg", "387.5deg"], opacity: [1, 1] }, { duration: 420, delay: 110 }),
      face.querySelector(".dial-shock")?.animate?.([{ scale: 0.25, opacity: 0 }, { opacity: 1, offset: 0.1 }, { scale: 1, opacity: 0 }], { duration: 520, delay: 90, easing: "cubic-bezier(.2, .6, .35, 1)" }),
      face.querySelector(".dial-logo[data-on] .dial-mark")?.animate?.({ scale: ["1", "1.14 .82", "1.18", "1"], offset: [0, 0.25, 0.55, 1] }, { duration: 420, delay: 70, easing: "ease-out" }),
    ];
    if (plane.current!.hasAttribute("data-open")) {
      anims.push(barText.current!.querySelector("b")?.animate?.({ scale: [1.9, 0.92, 1], opacity: [0, 1, 1], offset: [0, 0.55, 1] }, { duration: 240, delay: 40, easing: "ease-out", fill: "backwards" }));
    }
    intro.current = anims.filter((anim): anim is Animation => Boolean(anim));
  };

  // Steps stay separate from key handling so pointer and touch input can drive the same moves.
  const go = (j: number) => {
    const target = models[j];
    if (target && j !== index) onDraft(selectPickerModel(target.instance, target.cell.options[0]!.id, draft));
  };
  const stepModel = (dir: number) => onDraft(dialStep(rows, draft, dir));
  const shiftEffort = (dir: number) => onDraft(dialShift(rows, draft, dir));
  const type = (key: string) => {
    const now = performance.now();
    const text = now - typing.current.at < 800 ? typing.current.text + key : key;
    typing.current.text = text;
    typing.current.at = now;
    const found = dialFind(search, text);
    if (found >= 0) go(found);
    setTyped({ text, i: found, on: true });
    clearTimeout(typing.current.timer);
    typing.current.timer = window.setTimeout(() => setTyped((current) => ({ ...current, on: false })), 700);
  };
  useDialTouch(stage, phone, index, PHONE_PITCH * zoom, { step: stepModel, shift: shiftEffort });

  useImperativeHandle(handle, () => ({
    key: (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const moves: Record<string, () => void> = {
        ArrowUp: () => stepModel(-1),
        ArrowDown: () => stepModel(1),
        ArrowLeft: () => shiftEffort(-1),
        ArrowRight: () => shiftEffort(1),
      };
      if (key === "Enter") {
        const target = event.target instanceof Element ? event.target : null;
        if (target && target !== event.currentTarget && (!target.closest(".dial-stage") || (target.closest("button") && !target.closest(".dial-card")))) return false;
        quench();
        onSave(draft, true);
      } else if (moves[key]) {
        quench();
        typing.current.at = 0;
        moves[key]();
      } else if (/^[a-z0-9.]$/.test(key)) {
        quench();
        type(key);
      } else return false;
      event.preventDefault();
      return true;
    },
  }));

  const gauges = [...new Set(models.map((model) => pickerEfforts(model, model.cell).length))].filter((n) => n > 0);
  const stageStyle = {
    zoom,
    "--t": `${labMs}ms`,
    "--turn": turn,
    "--lab": labTurn,
    "--step": step,
    "--lab-step": labStep,
    "--accent": accent,
    "--g": `${150 + (level + 0.5) * 240 / Math.max(efforts.length, 1)}deg`,
  } as CSSProperties;
  const effortText = effort ? modelEffortLabel(effort.label, t) : "-";
  const sourceLine = (key: DialStat, value: number | undefined) => {
    const scores = efforts.length ? efforts.map((option) => dialScore(option.model ?? draft.model, option.effort, key)) : [value];
    if (value != null) return `${dialSource(key)} · ${scores.every((score) => score === value) ? t("model.dial.allEfforts") : effortText}`;
    const scored = efforts.filter((_, j) => scores[j] != null).map((option) => modelEffortLabel(option.label, t));
    return scored.length ? t("model.dial.noScoreAt", { effort: effortText, levels: scored.join(", ") }) : t("model.dial.notScored");
  };

  return (
    <div ref={stageRef} className="model-dial">
      <div ref={stage} className="dial-stage" style={stageStyle} data-boot={boot || undefined} data-max={max || undefined} data-phone={phone || undefined}>
        <div className="dial-layer dial-scene" aria-hidden>
          <div className="dial-layer dial-scene-base" />
          {rows.map((row, j) => <div key={row.instance.instanceId} className="dial-layer dial-scene-lab" data-on={j === lab || undefined} style={{ "--c": modelFamilyAccent(row.instance.driverKind) } as CSSProperties} />)}
        </div>
        <svg className="dial-orbits" viewBox="0 0 1200 1200" aria-hidden>
          <g fill="none" stroke="#ffffff" strokeOpacity=".05">
            <circle cx="600" cy="600" r="262" />
            <circle cx="600" cy="600" r="380" strokeDasharray="2 10" />
            <circle cx="600" cy="600" r="560" />
          </g>
        </svg>

        <header className="dial-top">
          <h2>{t("model.choose")}</h2>
          <p>{t("model.dial.subtitle", { models: count, labs: rows.length })}</p>
          <div className="dial-pill">{t("model.dial.asOf", { date: MODEL_INDEX_AS_OF })}</div>
        </header>

        <div className="dial-face">
          <svg className="dial-layer dial-spin dial-ticks" viewBox="0 0 480 480" aria-hidden>
            {models.map((model, j) => {
              const d = sector(212, 226, j * step - (step / 2 - 1), j * step + (step / 2 - 1));
              return <g key={`${model.instance.instanceId}:${model.cell.options[0]!.id}`} className="dial-chamber" data-on={j === index || undefined} style={{ "--c": modelFamilyAccent(model.instance.driverKind) } as CSSProperties}><path d={d} fill="#fff" fillOpacity=".07" /><path className="lit" d={d} /></g>;
            })}
            <g stroke="#fff" strokeOpacity=".35" strokeWidth="1.2">
              {models.map((_, j) => {
                if (count < 2 || labOf[j] === labOf[wrap(j + 1, count)]) return null;
                const [x0, y0] = point(208, j * step + step / 2);
                const [x1, y1] = point(230, j * step + step / 2);
                return <line key={j} x1={x0} y1={y0} x2={x1} y2={y1} />;
              })}
            </g>
            <circle cx="240" cy="240" r="232" fill="none" stroke="#fff" strokeOpacity=".06" />
          </svg>
          <svg className="dial-layer dial-spin dial-labring" viewBox="0 0 480 480" aria-hidden>
            <defs><radialGradient id="dial-seg-fill" cx="240" cy="240" r="206" gradientUnits="userSpaceOnUse"><stop offset=".68" stopColor="#16181f" /><stop offset="1" stopColor="#0d0f13" /></radialGradient></defs>
            {rows.map((row, j) => <path key={row.instance.instanceId} d={sector(142, 206, j * labStep - (labStep / 2 - 1), j * labStep + (labStep / 2 - 1))} fill="url(#dial-seg-fill)" stroke="#fff" strokeOpacity=".07" />)}
          </svg>
          {rows.map((row, j) => (
            <svg key={row.instance.instanceId} className="dial-layer dial-wedge" viewBox="0 0 480 480" data-on={j === lab || undefined} style={{ "--c": modelFamilyAccent(row.instance.driverKind), "--j": j } as CSSProperties} aria-hidden>
              <defs>
                <pattern id={`dial-hatch-${j}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.6" height="7" fill="currentColor" fillOpacity=".38" /></pattern>
                <radialGradient id={`dial-wash-${j}`} cx="240" cy="240" r="206" gradientUnits="userSpaceOnUse"><stop offset=".68" stopColor="currentColor" stopOpacity=".04" /><stop offset="1" stopColor="currentColor" stopOpacity=".22" /></radialGradient>
              </defs>
              <path d={sector(142, 206, -(labStep / 2 - 1), labStep / 2 - 1)} fill={`url(#dial-wash-${j})`} />
              <path d={sector(142, 206, -(labStep / 2 - 1), labStep / 2 - 1)} fill={`url(#dial-hatch-${j})`} stroke="currentColor" strokeOpacity=".35" />
              <path className="edge" d={sector(203, 207, -(labStep / 2 - 1), labStep / 2 - 1)} fill="currentColor" />
            </svg>
          ))}
          {rows.map((row, j) => (
            <button
              key={row.instance.instanceId}
              type="button"
              className="dial-seg dial-spin"
              data-dial-lab={row.instance.instanceId}
              data-on={j === lab || undefined}
              data-locked={locked(row) || undefined}
              style={{ "--a": `${j * labStep}deg`, "--c": modelFamilyAccent(row.instance.driverKind) } as CSSProperties}
              aria-label={locked(row) ? `${row.label}, ${t("model.signInRequired")}` : row.label}
              onClick={() => go(labOf.indexOf(j))}
            >
              <ProviderMark driverKind={row.instance.driverKind} size={18} className="dial-mark" />
              <ProviderMark driverKind={row.instance.driverKind} size={18} className="dial-mark lit" />
              {locked(row) && <Lock size={10} className="dial-lock" aria-hidden />}
            </button>
          ))}
          <div className="dial-socket" />
          {gauges.map((n) => {
            const notches = Array.from({ length: n }, (_, j) => sector(112, 124, 150 + j * 240 / n + 2.5, 150 + (j + 1) * 240 / n - 2.5));
            const on = n === efforts.length;
            return (
              <svg key={n} className="dial-layer dial-gauge" viewBox="0 0 480 480" data-on={on || undefined} aria-hidden>
                {notches.map((d, j) => (
                  <g key={j} className="dial-notch" data-lit={(on && j <= level) || undefined} style={{ "--p": j / Math.max(n - 1, 1) } as CSSProperties} onClick={() => on && efforts[j] && onDraft(selectPickerEffort(draft, efforts[j]!))}>
                    <path d={d} fill="#fff" fillOpacity=".07" />
                    <path className="lit" d={d} fill="var(--accent)" />
                  </g>
                ))}
              </svg>
            );
          })}
          <div className="dial-layer dial-overdrive" aria-hidden>
            <svg className="dial-layer" viewBox="0 0 480 480">{RING.map((a) => <path key={a} d={sector(128.5, 132, a - 4.75, a + 4.75)} style={{ "--p": +(wrap(a - 150, 360) / 240).toFixed(3) } as CSSProperties} />)}</svg>
            <i className="dial-layer head" />
            <i className="dial-shock" />
          </div>
          {efforts.length > 0 && <div className="dial-layer dial-spin dial-pointer"><div className="dial-nub" /></div>}
          <div ref={tile} className="dial-tile">
            {rows.map((row, j) => (
              <div key={row.instance.instanceId} className="dial-logo" data-on={j === lab || undefined} style={{ "--c": modelFamilyAccent(row.instance.driverKind), "--j": j } as CSSProperties}>
                <ProviderMark driverKind={row.instance.driverKind} size={72} className="dial-mark" />
              </div>
            ))}
          </div>
          {effort && <div className="dial-effort" aria-hidden>{t("model.effort")}<b>{effortText}</b></div>}
        </div>

        <div className="dial-wheel">
          <div ref={plane} className="dial-plane">
            <div className="dial-bar" aria-hidden><span ref={barText} className="dial-bar-text" /><i ref={caret} className="dial-caret" /></div>
            <div className="dial-link" />
            {models.map((model, j) => {
              const k = shortest(j - index, count);
              const ak = Math.abs(k);
              const fade = (phone ? PHONE_FADE : FADE)[ak];
              const option = j === index ? draft.model : model.cell.options[0]!.id;
              const cost = dialPrice(option);
              return (
                <button
                  key={`${model.instance.instanceId}:${model.cell.options[0]!.id}`}
                  type="button"
                  tabIndex={-1}
                  className="dial-card"
                  data-model-row={model.instance.instanceId}
                  data-model-cell={model.cell.options[0]!.id}
                  aria-pressed={j === index}
                  style={{ "--k": k, "--ak": ak, "--o": fade ?? 0, "--lag": `${lead && Math.min(Math.max(1 + lead * k, 0), 2) * 10}ms`, pointerEvents: fade ? undefined : "none" } as CSSProperties}
                  onClick={() => (j === index ? onSave() : go(j))}
                >
                  <ProviderMark driverKind={model.instance.driverKind} size={18} className="dial-mark" />
                  <span className="dial-card-text">
                    <span className="dial-card-name">{names[j]!.name}{names[j]!.tag && <em>{names[j]!.tag}</em>}</span>
                    <span className="dial-card-line">{model.cell.offList ? t("model.offList") : option}</span>
                  </span>
                  <span className="dial-card-badge">{locked(rows[labOf[j]!]!) ? <Lock size={12} aria-label={t("model.signInRequired")} /> : cost ? dialTier(cost.blend) : "-"}</span>
                </button>
              );
            })}
            {rows.map((row, j) => <div key={row.instance.instanceId} className="dial-frame" data-on={j === lab || undefined} style={{ "--c": modelFamilyAccent(row.instance.driverKind) } as CSSProperties} />)}
          </div>
        </div>

        <nav className="dial-rail" aria-label={t("model.engineAxis")}>
          <button type="button" aria-label={t("model.previousModel")} onClick={() => stepModel(-1)}><ArrowUp size={18} /></button>
          <button type="button" data-pick aria-label={t("model.dial.pick")} disabled={!pickable} onClick={() => onSave()}><Square size={16} /></button>
          <button type="button" aria-label={t("model.nextModel")} onClick={() => stepModel(1)}><ArrowDown size={18} /></button>
        </nav>
        <div className="dial-typeahead" data-on={typed.on || undefined} data-miss={typed.i < 0 || undefined} aria-hidden>
          {typed.i < 0 ? t("model.dial.noMatch", { query: typed.text }) : <>{typed.text} → <b>{search[typed.i]?.slice(models[typed.i]!.label.length + 1)}</b></>}
        </div>

        <section className="dial-stats">
          <button type="button" className="dial-cta" data-dial-pick disabled={!pickable} onClick={() => onSave()}>{t("model.dial.pick")} <kbd>Enter</kbd></button>
          <div className="dial-stat">
            <div className="dial-ring" data-none={intel == null || undefined}>
              <div className="track" />
              <div className="fill">
                <div className="half r"><div ref={(el) => { arcs.current[0] = el; }} className="arc" /></div>
                <div className="half l"><div ref={(el) => { arcs.current[1] = el; }} className="arc" /></div>
                <div className="cap" />
                <div ref={(el) => { arcs.current[2] = el; }} className="cap" />
              </div>
              <div className="num"><Odometer value={intel} int={DIAL_DIGITS.intelligence} dec={1} /></div>
            </div>
            <div className="dial-stat-text"><span className="dial-label">{t("modelIndex.index.intelligence")}</span><span className="dial-src">{sourceLine("intelligence", intel)}</span></div>
          </div>
          <div className="dial-stat-text">
            <span className="dial-label">{t("modelIndex.index.coding")}</span>
            <span className="dial-big"><Odometer value={coding} int={DIAL_DIGITS.coding} dec={1} /></span>
            <span className="dial-src">{sourceLine("coding", coding)}</span>
          </div>
          <div className="dial-stat-text">
            <span className="dial-label">{t("modelIndex.index.cost")}</span>
            <span className="dial-big dial-cost">
              $<Odometer value={price?.blend} int={DIAL_DIGITS.cost} dec={2} /><span className="unit">/1M</span>
              <span ref={squiggle} className="dial-squiggle" aria-hidden><span className="wipe"><svg viewBox="0 -3 240 16"><path d={`M1 5${SQUIGGLE}`} /></svg></span></span>
            </span>
            <span className="dial-src">{pickerPrice(draft.model) ? `${pickerPrice(draft.model)} ${t("model.pricePerMillion")}` : "-"}</span>
          </div>
        </section>

        <footer className="dial-footer" id={bindingsId}>
          <span className="dial-keys">
            <span><kbd>↑</kbd><kbd>↓</kbd>{t("model.engineAxis")}</span>
            <span><kbd>←</kbd><kbd>→</kbd>{t("model.modelAxis")}</span>
            <span><kbd>Enter</kbd>{t("settings.profile.save")}</span>
            <span><kbd>Esc</kbd>{t("createBot.cancel")}</span>
          </span>
          <span>{item?.label.toUpperCase()} · <b>{names[index]?.name.toUpperCase()}</b> · {String(index + 1).padStart(2, "0")}/{String(count).padStart(2, "0")}</span>
        </footer>
        <div className="sr-only" aria-live="polite">{live}</div>
      </div>
    </div>
  );
}
