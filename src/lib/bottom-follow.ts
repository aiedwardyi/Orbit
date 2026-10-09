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

/** The newest row is under the fold, so Jump to latest has somewhere to go. */
export function newestBelowView(el: ScrollBox): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight >= BOTTOM_FOLLOW_THRESHOLD;
}

/** Nothing to scroll; a transcript that isn't laid out (hidden, test DOM) reads 0 and never counts. */
export function transcriptUnderfilled(el: ScrollBox): boolean {
  return el.clientHeight > 0 && el.scrollHeight <= el.clientHeight;
}
