import { describe, expect, it } from "vitest";

import { botClears, groupClears } from "./wire-clears.ts";

const wire = (frame: ReturnType<typeof botClears> | ReturnType<typeof groupClears>) => JSON.parse(JSON.stringify(frame));

describe("wire clears", () => {
  it("sends every clearable bot field as null once cleared", () => {
    expect(wire(botClears({}))).toEqual({
      pinnedMessageId: null,
      section: null,
      mascotStyle: null,
      browserProfile: null,
      rememberedProjectCwd: null,
    });
  });

  it("sends every clearable room field as null once cleared", () => {
    expect(wire(groupClears({}))).toEqual({ pinnedMessageId: null, section: null, cwd: null });
  });

  it("passes set values through", () => {
    expect(wire(botClears({ pinnedMessageId: "m1", lastProjectCwd: "C:/work" }))).toMatchObject({
      pinnedMessageId: "m1",
      rememberedProjectCwd: "C:/work",
    });
    expect(wire(groupClears({ pinnedMessageId: "m1", cwd: "C:/work" }))).toMatchObject({ pinnedMessageId: "m1", cwd: "C:/work" });
  });
});
