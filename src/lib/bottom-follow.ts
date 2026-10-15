/** Subpixel slack for "at the rest position" - not a magnet zone. Handles
 * high-DPI fractional scaling without creating a wide snap zone. */
export const BOTTOM_FOLLOW_THRESHOLD = 16;

/**
 * Resume automatic bottom-follow only when the reader is already at the
 * rest position and still moving toward it. Re-pinning must not imply a
 * snap; the scroll effect follows new content, it does not yank the viewport.
 */
export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}

type ScrollBox = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export type TranscriptScroll = Pick<HTMLElement, "scrollHeight" | "scrollTop">;

export function captureTranscriptScroll(el: TranscriptScroll | null): TranscriptScroll | null {
  return el ? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop } : null;
}

export function restoreTranscriptScroll(el: TranscriptScroll, before: TranscriptScroll) {
  // Native anchoring may already have moved the viewport after the prepend.
  el.scrollTop = before.scrollTop + el.scrollHeight - before.scrollHeight;
}

export type TranscriptAnchor = { attribute: "data-mid" | "data-run"; id: string; top: number };

function rowBox(row: Element): DOMRect | undefined {
  return [row, ...row.children].map((el) => el.getBoundingClientRect()).filter((box) => box.height > 0).at(-1);
}

export function captureTranscriptAnchor(el: HTMLElement | null): TranscriptAnchor | null {
  if (!el) return null;
  const pane = el.getBoundingClientRect();
  for (const row of el.querySelectorAll("[data-mid], [data-run]")) {
    const box = rowBox(row);
    if (!box || box.bottom <= pane.top || box.top >= pane.bottom) continue;
    const attribute = row.hasAttribute("data-mid") ? "data-mid" : "data-run";
    return { attribute, id: row.getAttribute(attribute)!, top: box.top };
  }
  return null;
}

export function restoreTranscriptAnchor(el: HTMLElement, anchor: TranscriptAnchor): void {
  const row = Array.from(el.querySelectorAll(`[${anchor.attribute}]`)).find((row) => row.getAttribute(anchor.attribute) === anchor.id);
  const box = row && rowBox(row);
  if (box) el.scrollTop += box.top - anchor.top;
}

export function distanceFromTranscriptEdge(el: HTMLElement): number {
  const rows = el.querySelectorAll("[data-mid], [data-run]");
  const row = rows[rows.length - 1];
  const box = row && rowBox(row);
  return box ? box.bottom - el.getBoundingClientRect().bottom : el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** The newest row is under the fold, so Jump to latest has somewhere to go. `after` is what
 * follows that row (presence row, padding), which can sit under the fold while the row shows. */
export function newestBelowView(el: ScrollBox, after = 0): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight - after >= BOTTOM_FOLLOW_THRESHOLD;
}

/** Height of the transcript below its newest message row or folded run. Rows are display:contents wrappers, so their children carry the boxes. */
export function spaceAfterNewestRow(content: HTMLElement): number {
  const rows = content.querySelectorAll("[data-mid], [data-run]");
  const newest = rows[rows.length - 1];
  if (!newest) return 0;
  const bottoms = [newest, ...newest.children].map((el) => el.getBoundingClientRect()).filter((box) => box.height > 0).map((box) => box.bottom);
  return bottoms.length ? Math.max(0, content.getBoundingClientRect().bottom - Math.max(...bottoms)) : 0;
}

/** Nothing to scroll; a transcript that isn't laid out (hidden, test DOM) reads 0 and never counts. */
export function transcriptUnderfilled(el: ScrollBox): boolean {
  return el.clientHeight > 0 && el.scrollHeight <= el.clientHeight;
}
