export const SESSION_NOTICE_REPEAT_MS = 24 * 60 * 60_000;

/** Last showing per notice key: the provider session it rode and when. */
export type SessionNoticeMarks = Record<string, { cursor: string; at: number }>;

/** Once per provider session, again after a day in the same one. `cursor` is "" before a session exists. */
export function sessionNoticeDue(shown: SessionNoticeMarks, cursor: string, key: string, now: number): boolean {
  const last = shown[key];
  return !last || last.cursor !== cursor || now - last.at >= SESSION_NOTICE_REPEAT_MS;
}
