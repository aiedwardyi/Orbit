// Timeline rail geometry: where each turn sits on the rail and in the card,
// which turn a point means, and the lens that spreads turns when the pointer slows.

const DAY_MS = 86_400_000;
// day gaps never take more than this share of the rail
const GAP_SHARE = 0.3;
// within this many px of an end, the rail means the first or the latest turn
const END_PX = 3;

/** Each time's local calendar day, numbered so the next day is one more. */
export function dayNumbers(at: readonly number[]): Int32Array {
  const days = new Int32Array(at.length);
  for (let t = 0; t < at.length; t++) {
    const d = new Date(at[t]!);
    days[t] = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  }
  return days;
}

export interface RailFrame {
  width: number;
  height: number;
  scrollbar: number;
  narrow: boolean;
  /** The rail sits on the left edge, away from a drawer on the right. */
  mirror: boolean;
  edge: number;
  top: number;
  /** Rail length. */
  h: number;
  /** x of the rail's outer edge, in the transcript box. */
  railX: number;
  hitWidth: number;
}

/** Rail box for a transcript of this size; the column is 960 px at most with 20 px padding. */
export function railFrame(width: number, height: number, scrollbar: number, mirror: boolean): RailFrame {
  const narrow = width < 640;
  const edge = narrow ? 4 : 6;
  const top = narrow ? 12 : 16;
  const free = (width - scrollbar - Math.min(960, width - scrollbar)) / 2 + 20;
  return {
    width, height, scrollbar, narrow, mirror, edge, top,
    h: Math.max(0, height - top * 2),
    railX: mirror ? edge : width - scrollbar - edge,
    hitWidth: narrow ? 30 : Math.min(34, Math.max(18, free - 6)),
  };
}

/** Rail y of every turn: even steps, a gap where a day ends, a wider one across empty days. */
export function railPositions(days: ArrayLike<number>, length: number, gap: number): Float32Array {
  const n = days.length;
  const units = new Float32Array(n);
  let total = 0;
  for (let t = 1; t < n; t++) {
    const apart = days[t]! - days[t - 1]!;
    total += apart > 1 ? 2 : apart > 0 ? 1 : 0;
    units[t] = total;
  }
  const g = total ? Math.min(gap, (length * GAP_SHARE) / total) : 0;
  const pitch = n > 1 ? (length - total * g) / (n - 1) : 0;
  const pos = new Float32Array(n);
  for (let t = 0; t < n; t++) pos[t] = t * pitch + units[t]! * g;
  return pos;
}

/** First index whose value is at least `p`. */
export function lowerBound(values: ArrayLike<number>, p: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the value nearest `p`. */
export function nearestIndex(values: ArrayLike<number>, p: number): number {
  const i = lowerBound(values, p);
  if (i <= 0) return 0;
  if (i >= values.length) return values.length - 1;
  return p - values[i - 1]! <= values[i]! - p ? i - 1 : i;
}

/** Where the lens draws rail point `p`: within `radius` of `center` it spreads by `zoom`, outside it stays put. */
export function lensOut(p: number, center: number, radius: number, zoom: number): number {
  if (zoom < 1e-3) return p;
  const x = (p - center) / radius;
  if (x <= -1 || x >= 1) return p;
  const a = Math.abs(x);
  return center + Math.sign(x) * (((zoom + 1) * a) / (zoom * a + 1)) * radius;
}

/** The rail point the lens draws at `y`. */
export function lensIn(y: number, center: number, radius: number, zoom: number): number {
  if (zoom < 1e-3) return y;
  const x = (y - center) / radius;
  if (x <= -1 || x >= 1) return y;
  const a = Math.abs(x);
  return center + Math.sign(x) * (a / (zoom + 1 - zoom * a)) * radius;
}

/** The turn under rail y `y`; the ends always mean the first and the latest. */
export function railPick(y: number, length: number, pos: ArrayLike<number>, center: number, radius: number, zoom: number): number {
  if (!pos.length) return -1;
  if (y <= END_PX) return 0;
  if (y >= length - END_PX) return pos.length - 1;
  return nearestIndex(pos, lensIn(y, center, radius, zoom));
}

export interface CardLayout {
  /** Strip y of each turn's row. */
  rowY: Float64Array;
  /** Strip y of each day's header. */
  headY: Float64Array;
  /** First turn of each day. */
  headTurn: Int32Array;
  /** Header index of each turn's day. */
  dayOf: Int32Array;
  length: number;
}

/** The card strip: a header where each day starts, then a row per turn. */
export function cardLayout(days: ArrayLike<number>, rowH: number, headH: number): CardLayout {
  const n = days.length;
  const rowY = new Float64Array(n);
  const dayOf = new Int32Array(n);
  const heads: number[] = [];
  const firsts: number[] = [];
  let y = 0;
  for (let t = 0; t < n; t++) {
    if (t === 0 || days[t] !== days[t - 1]) {
      heads.push(y);
      firsts.push(t);
      y += headH;
    }
    rowY[t] = y;
    dayOf[t] = heads.length - 1;
    y += rowH;
  }
  return { rowY, headY: Float64Array.from(heads), headTurn: Int32Array.from(firsts), dayOf, length: y };
}

/** The turn whose row center is nearest strip y `y`. */
export function rowAt(rowY: ArrayLike<number>, rowH: number, y: number): number {
  const n = rowY.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rowY[mid]! + rowH / 2 <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo < n - 1 && rowY[lo + 1]! + rowH / 2 - y < y - rowY[lo]! - rowH / 2 ? lo + 1 : lo;
}

/** As many words as fit `width`, cut at a word with an ellipsis; only a first word wider than the row is cut inside. */
export function fitWords(words: string, width: number, measure: (text: string) => number): string {
  if (measure(words) <= width) return words;
  let cut = words.endsWith("…") ? words.slice(0, -1) : words;
  while (cut.includes(" ") && measure(`${cut}…`) > width) cut = cut.slice(0, cut.lastIndexOf(" "));
  cut = cut.replace(/[.,;:!?]+$/, "");
  if (measure(`${cut}…`) > width) {
    const chars = Array.from(cut);
    while (chars.length > 1 && measure(`${chars.join("")}…`) > width) chars.pop();
    cut = chars.join("");
  }
  return `${cut}…`;
}
