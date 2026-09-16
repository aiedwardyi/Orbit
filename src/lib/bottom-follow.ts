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
