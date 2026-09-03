// Unlike a bot name, an emptied bulletin is a real edit - clearing the
// instructions has to commit.

export function nextBulletin(current: string, draft: string): string | null {
  return draft === current ? null : draft;
}
