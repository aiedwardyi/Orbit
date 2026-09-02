// Custom picker: search the live inject list, and pin models the host
// already has in memory so the user can pick them without scrolling.

export function filterCustomModels<T extends { id: string; label: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) => option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
}

export function partitionCustomModels<T extends { id: string; loaded?: boolean }>(
  options: readonly T[],
) {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    if (option.loaded) pinned.push(option);
    else rest.push(option);
  }
  return { pinned, rest };
}

/** Compact suggested list in catalog order. Default and current stay in
 * that order so a click moves the checkmark, not the rows. Must-show ids
 * (default, current) are always included even if they exceed limit. */
export function suggestedModels<T extends { id: string }>(
  options: readonly T[],
  defaultId: string,
  currentId: string | undefined,
  limit = 5,
): T[] {
  const must = new Set<string>();
  if (defaultId) must.add(defaultId);
  if (currentId) must.add(currentId);
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    if (picked.length < limit || must.has(option.id)) picked.push(option);
  }
  return picked;
}
