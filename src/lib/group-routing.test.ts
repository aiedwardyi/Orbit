import { describe, expect, it } from "vitest";

import { translate } from "./i18n";
import { groupComposerHint, groupResponseHint, roomRespondersForComposer } from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Milind take this", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "everyone" } })).toEqual(members);
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "mentions" } })).toEqual([]);
    expect(roomRespondersForComposer("@everyone hello", members, { defaultResponder: { kind: "mentions" } })).toEqual(
      members,
    );
  });
});


describe("group chrome phrases", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];
  const room = {
    name: "Launch",
    defaultResponder: { kind: "everyone" },
  } satisfies { name: string; defaultResponder: { kind: "everyone" } };

  it("returns complete Korean response hints, not English sentences", () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
      translate("ko", key, vars);
    expect(groupResponseHint(room, members, t)).toBe(translate("ko", "room.hint.everyone"));
    expect(groupResponseHint(room, members, t)).not.toMatch(/Everyone responds|@mention/i);
    const lead = { ...room, defaultResponder: { kind: "member" as const, botId: "atlas" } };
    expect(groupResponseHint(lead, members, t)).toContain("Atlas");
    expect(groupResponseHint(lead, members, t)).not.toMatch(/responds by default/i);
  });

  it("returns complete Korean composer placeholders without English fragments", () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
      translate("ko", key, vars);
    const everyone = groupComposerHint(room, members, t);
    expect(everyone).toBe(translate("ko", "composer.roomEveryone", { name: "Launch" }));
    expect(everyone).not.toMatch(/everyone responds|Message Launch/i);
    const lead = groupComposerHint({ ...room, defaultResponder: { kind: "member", botId: "atlas" } satisfies { kind: "member"; botId: string } }, members, t);
    expect(lead).toContain("Atlas");
    expect(lead).toContain("Launch");
    expect(lead).not.toMatch(/Atlas responds/i);
  });
});
