export type SidebarItemKind = "bot" | "group";
export type SidebarItemOrder = Record<string, string[]>;

export type SidebarOrder = {
  sectionOrder: string[];
  itemOrder: SidebarItemOrder;
};

export const UNASSIGNED_SECTION_ID = "unassigned";

export function sidebarItemKey(kind: SidebarItemKind, id: string): string {
  return `${kind}:${id}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function orderedSidebarItems(present: readonly string[], saved: readonly string[] = []): string[] {
  const visible = unique(present);
  const visibleSet = new Set(visible);
  const result = unique(saved).filter((key) => visibleSet.has(key));
  for (const key of visible) {
    if (!result.includes(key)) result.push(key);
  }
  return result;
}

export function normalizeSidebarOrder(
  order: SidebarOrder,
  presentSections: readonly string[],
  presentItems: Readonly<Record<string, readonly string[]>>,
): SidebarOrder {
  const sections = unique(presentSections);
  const sectionSet = new Set(sections);
  const savedSections = unique(order.sectionOrder).filter((id) => sectionSet.has(id));
  for (const id of sections) {
    if (savedSections.includes(id)) continue;
    const naturalIndex = sections.indexOf(id);
    const predecessor = sections.slice(0, naturalIndex).reverse().find((candidate) => savedSections.includes(candidate));
    const successor = sections.slice(naturalIndex + 1).find((candidate) => savedSections.includes(candidate));
    if (predecessor) savedSections.splice(savedSections.indexOf(predecessor) + 1, 0, id);
    else if (successor) savedSections.splice(savedSections.indexOf(successor), 0, id);
    else savedSections.push(id);
  }
  const itemOrder: SidebarItemOrder = {};
  for (const id of sections) {
    itemOrder[id] = orderedSidebarItems(presentItems[id] ?? [], order.itemOrder[id] ?? []);
  }
  return { sectionOrder: savedSections, itemOrder };
}

export type SidebarItemDropPlace = "before" | "after" | "end";

export function moveSidebarItem(
  itemOrder: SidebarItemOrder,
  _fromSectionId: string,
  targetSectionId: string,
  fromKey: string,
  targetKey?: string,
  place: SidebarItemDropPlace = "before",
): SidebarItemOrder {
  const next: SidebarItemOrder = Object.fromEntries(
    Object.entries(itemOrder).map(([id, keys]) => [id, unique(keys)]),
  );
  for (const keys of Object.values(next)) {
    let index = keys.indexOf(fromKey);
    while (index >= 0) {
      keys.splice(index, 1);
      index = keys.indexOf(fromKey);
    }
  }
  const target = next[targetSectionId] ?? (next[targetSectionId] = []);
  if (place === "end" || !targetKey) {
    target.push(fromKey);
    return next;
  }
  const targetIndex = target.indexOf(targetKey);
  target.splice(targetIndex < 0 ? target.length : targetIndex + (place === "after" ? 1 : 0), 0, fromKey);
  return next;
}

export function sameSidebarOrder(a: SidebarOrder, b: SidebarOrder): boolean {
  if (a.sectionOrder.length !== b.sectionOrder.length) return false;
  if (a.sectionOrder.some((id, index) => id !== b.sectionOrder[index])) return false;
  const ids = new Set([...Object.keys(a.itemOrder), ...Object.keys(b.itemOrder)]);
  for (const id of ids) {
    const left = a.itemOrder[id] ?? [];
    const right = b.itemOrder[id] ?? [];
    if (left.length !== right.length || left.some((key, index) => key !== right[index])) return false;
  }
  return true;
}
