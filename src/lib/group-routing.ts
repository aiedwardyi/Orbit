import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { t, type Translate } from "./i18n";

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

export function defaultResponderName(group: Pick<Group, "defaultResponder">, members: Array<Pick<Bot, "id" | "name">>): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

export function groupResponseHint(group: Pick<Group, "dm" | "defaultResponder">, members: Array<Pick<Bot, "id" | "name">>, translate: Translate = t): string {
  if (group.dm) return translate("room.hint.dm");
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return translate("room.hint.everyone");
  if (value.kind === "mentions") return translate("room.hint.mentions");
  const name = defaultResponderName(group, members) ?? translate("room.leadBot");
  return translate("room.hint.lead", { name });
}

/** Complete composer placeholder for a room — never an English fragment glued into another phrase. */
export function groupComposerHint(group: Pick<Group, "name" | "dm" | "defaultResponder">, members: Array<Pick<Bot, "id" | "name">>, translate: Translate = t): string {
  if (group.dm) return translate("composer.roomDm", { name: group.name });
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return translate("composer.roomEveryone", { name: group.name });
  if (value.kind === "mentions") return translate("composer.roomMentions", { name: group.name });
  const lead = defaultResponderName(group, members) ?? translate("room.lead");
  return translate("composer.roomLead", { name: group.name, lead });
}

/** Same routing sendGroup uses: explicit @mentions win, otherwise the
 * room's default responder. Keep this aligned with server/store.ts
 * `roomResponders` / `mentionedBots`. */
export function roomRespondersForComposer<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedMembers(text, available);
  if (mentioned.length) return mentioned;
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone") return available;
  if (fallback.kind === "member") {
    const lead = available.find((member) => member.id === fallback.botId);
    return lead ? [lead] : [];
  }
  return [];
}

function mentionedMembers<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length];
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}
