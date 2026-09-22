import { userSectionId } from "./sidebar-layout";

export type SidebarItemKind = "bot" | "group";
export type SidebarItemOrder = Record<string, string[]>;

export type SidebarOrder = {
  sectionOrder: string[];
  itemOrder: SidebarItemOrder;
};

export type SidebarPriority = "chief" | "pinned";

export type SidebarPriorityPartition = {
  chief: string[];
  pinned: string[];
  regular: SidebarItemOrder;
};

export const UNASSIGNED_SECTION_ID = "unassigned";

export function sidebarPriorityFor(value: { chiefOfStaff?: boolean; pinned?: boolean }): SidebarPriority | null {
  if (value.chiefOfStaff) return "chief";
  if (value.pinned) return "pinned";
  return null;
}

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

export function partitionSidebarItemKeys(
  sectionOrder: readonly string[],
  itemOrder: Readonly<SidebarItemOrder>,
  priorityByKey: Readonly<Record<string, SidebarPriority | null | undefined>>,
): SidebarPriorityPartition {
  const partition: SidebarPriorityPartition = { chief: [], pinned: [], regular: {} };
  const seen = new Set<string>();
  const sections = [...new Set([...sectionOrder, ...Object.keys(itemOrder)])];
  for (const sectionId of sections) {
    const regular = (partition.regular[sectionId] ??= []);
    for (const key of itemOrder[sectionId] ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      const priority = priorityByKey[key];
      if (priority) partition[priority].push(key);
      else regular.push(key);
    }
  }
  return partition;
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

export function moveSidebarItemWithinTier(
  itemOrder: SidebarItemOrder,
  sectionId: string,
  fromKey: string,
  targetKey: string,
  tierKeys: readonly string[],
  place: Exclude<SidebarItemDropPlace, "end"> = "before",
): SidebarItemOrder {
  const next: SidebarItemOrder = Object.fromEntries(
    Object.entries(itemOrder).map(([id, keys]) => [id, unique(keys)]),
  );
  const keys = next[sectionId] ?? [];
  const slots = keys.flatMap((key, index) => (tierKeys.includes(key) ? [index] : []));
  const tier = slots.map((index) => keys[index]!);
  const fromIndex = tier.indexOf(fromKey);
  const targetIndex = tier.indexOf(targetKey);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return next;
  tier.splice(fromIndex, 1);
  tier.splice(targetIndex + (place === "after" ? 1 : 0), 0, fromKey);
  for (const [index, slot] of slots.entries()) keys[slot] = tier[index]!;
  return next;
}

export type SidebarStartupBot = {
  id: string;
  section?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  pinned?: boolean;
};

export type SidebarStartupGroup = {
  id: string;
  section?: string;
};

/** The id the sidebar renders first: chief tier, then pinned tier, then the
 * first regular item in section order. Mirrors Sidebar.tsx's render order. */
export function preferredStartupSelectionId(
  bots: readonly SidebarStartupBot[],
  groups: readonly SidebarStartupGroup[],
  order: SidebarOrder,
): string {
  const sectionIdFor = (section?: string) => (section?.trim() ? userSectionId(section.trim()) : UNASSIGNED_SECTION_ID);
  const items = [
    ...groups.map((group) => ({
      key: sidebarItemKey("group", group.id),
      id: group.id,
      sectionId: sectionIdFor(group.section),
      priority: null as SidebarPriority | null,
    })),
    ...bots
      .filter((bot) => !bot.hidden)
      .map((bot) => ({
        key: sidebarItemKey("bot", bot.id),
        id: bot.id,
        sectionId: sectionIdFor(bot.section),
        priority: sidebarPriorityFor(bot),
      })),
  ];
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const itemsBySection: SidebarItemOrder = {};
  for (const item of items) (itemsBySection[item.sectionId] ??= []).push(item.key);
  const sections = [UNASSIGNED_SECTION_ID, ...Object.keys(itemsBySection).filter((id) => id !== UNASSIGNED_SECTION_ID)];
  const normalized = normalizeSidebarOrder(order, sections, itemsBySection);
  const priorityByKey = Object.fromEntries(items.map((item) => [item.key, item.priority]));
  const partition = partitionSidebarItemKeys(normalized.sectionOrder, normalized.itemOrder, priorityByKey);
  const orderedKeys = [
    ...partition.chief,
    ...partition.pinned,
    ...normalized.sectionOrder.flatMap((id) => partition.regular[id] ?? []),
  ];
  for (const key of orderedKeys) {
    const id = itemByKey.get(key)?.id;
    if (id) return id;
  }
  return bots[0]?.id ?? "";
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
