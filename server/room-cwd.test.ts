import { describe, expect, it } from "vitest";

import { groupTurnCwd } from "./room-cwd.ts";

describe("groupTurnCwd", () => {
  it("the room's pinned folder overrides the member's own default", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => "/tmp/room")).toBe("/tmp/room");
  });

  it("a room with no folder keeps each member's own default", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => null)).toBe("/workspaces/bot-a");
  });

  it("a room with no folder keeps the member's own pinned project folder", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => null, "/repos/orbit")).toBe("/repos/orbit");
  });

  it("the room's pinned folder overrides the member's own pin", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => "/tmp/room", "/repos/orbit")).toBe("/tmp/room");
  });

  it("an off-host member gets no folder even when it has its own pin", () => {
    expect(groupTurnCwd(undefined, () => null, "/repos/orbit")).toBeUndefined();
  });

  it("an off-host member gets no folder and cannot decide the room's pin", () => {
    let pinCalls = 0;
    expect(groupTurnCwd(undefined, () => {
      pinCalls += 1;
      return "/tmp/room";
    })).toBeUndefined();
    expect(pinCalls).toBe(0);
  });
});
