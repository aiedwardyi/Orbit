/** Long computer-use threads carry hundreds of rows (inline screenshots
 * included); mounting all of them makes the DOM heavy even though the memoized
 * list bails out of re-renders. Only the last `TRANSCRIPT_WINDOW_SIZE`
 * messages mount by default; a pill expands by the same step. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

export interface TranscriptWindow<T> {
  visible: T[];
  /** Messages hidden before the window — the pill's "(X more)" count. */
  hiddenCount: number;
  /** Messages hidden after a finite search-focus window. */
  laterCount: number;
  /** The boundary actually applied after clamping; expand steps from this,
   * not from the stored value, so a clamped window expands predictably. */
  startIndex: number;
  /** Exclusive end boundary, or the current list length for a tail window. */
  endIndex: number;
}

/** Boundary for a fresh window: the last `size` messages, or the last `size`
 * that `renders`, so a tail of hidden tool rows cannot mount blank. */
export function tailWindowStart(
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  renders?: (index: number) => boolean,
): number {
  if (!renders) return Math.max(0, total - size);
  let counted = 0;
  for (let i = total - 1; i >= 0; i--) {
    if (renders(i) && ++counted >= size) return i;
  }
  return 0;
}

/** One "Show earlier" click: pull the boundary back by another `size`. */
export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

export function advanceWindow(
  startIndex: number,
  endIndex: number,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  renders: (index: number) => boolean = () => true,
): { start: number; end: number | null } {
  let end = endIndex;
  for (let counted = 0; end < total && counted < size; end++) if (renders(end)) counted++;
  return { start: Math.max(startIndex, tailWindowStart(end, size * 2, renders)), end: end >= total ? null : end };
}

export function shouldAdvanceWindow(movingDown: boolean, distanceFromEdge: number, clientHeight: number): boolean {
  return movingDown && clientHeight > 0 && distanceFromEdge <= clientHeight;
}

/** A followed tail slides once it outgrows two windows, so a long live session
 * stops mounting every new row. Only safe while the reader is at the bottom. */
export function followedTailStart(
  startIndex: number,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  renders?: (index: number) => boolean,
): number {
  return total - startIndex > size * 2 ? tailWindowStart(total, size, renders) : startIndex;
}

/** A followed tail lets go of opened scrollback, or one "Show earlier" pins every later row. */
export function followedWindow<W extends { start: number; end: number | null; expanded?: boolean }>(
  window: W,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  renders?: (index: number) => boolean,
): W {
  if (window.end !== null) return window;
  const start = followedTailStart(window.start, total, size, renders);
  return start === window.start && !window.expanded ? window : { ...window, start, expanded: false };
}

/** Older rows were prepended: keep the window on the same rows, or open one
 * "Show earlier" step into them when the reader asked for them. */
export function shiftForPrepend<W extends { start: number; end: number | null }>(
  window: W,
  count: number,
  reveal: boolean,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): W {
  return {
    ...window,
    start: reveal && window.start === 0 ? expandWindowStart(count, size) : window.start + count,
    end: window.end === null ? null : window.end + count,
  };
}

// rendering rows mounted above a target the window grows to reach
const FOCUS_CONTEXT = 10;

/** The window for landing on a message. One that already holds it is returned
 * as is; one that starts below it grows its start while it stays within two
 * windows of rendering rows; anything farther, or a fresh jump page with no
 * window (null), gets a bounded window around it. */
export function focusWindow<W extends { start: number; end: number | null }>(
  window: W | null,
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  renders: (index: number) => boolean = () => true,
): W | { start: number; end: number | null } {
  const end = window?.end ?? total;
  if (window && window.start <= targetIndex && targetIndex < end) return window;
  const back = (from: number, count: number) => {
    let start = from;
    for (let counted = 0; start > 0 && counted < count; ) if (renders(--start)) counted++;
    return start;
  };
  if (window && targetIndex < window.start) {
    const start = back(targetIndex, FOCUS_CONTEXT);
    let counted = 0;
    for (let i = start; i < end; i++) if (renders(i)) counted++;
    if (counted <= size * 2) return { start, end: window.end };
  }
  const start = back(targetIndex, Math.floor(size / 2));
  let stop = start;
  for (let counted = 0; stop < total && counted < size; stop++) if (renders(stop)) counted++;
  return stop >= total ? { start: Math.min(start, tailWindowStart(total, size, renders)), end: null } : { start, end: stop };
}

/** Resolve a stored boundary against the current list. The boundary is
 * anchored — appends grow the window instead of sliding it, so rows the
 * reader is looking at never drop out from under them. Anchoring means a
 * thread that shrinks (branch switch, edit rewinding the tail) can leave the
 * boundary at or past the new end; that stale boundary falls back to a fresh
 * tail window rather than blanking the transcript. */
export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? tailWindowStart(messages.length, size)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: start,
    laterCount: messages.length - end,
    startIndex: start,
    endIndex: end,
  };
}
