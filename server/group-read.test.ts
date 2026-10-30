import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { Store, type GroupRecord } from "./store.ts";

async function patchRead(body: unknown) {
  const store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const bot = store.createBot();
  const group = store.createGroup("Team", [bot.id]);
  store.patchGroup(group.id, { unread: true });
  const routes = createGroupRoutes({ store, groupIsWorking: () => false, publicGroupState: (value: GroupRecord) => value } as unknown as Parameters<typeof createGroupRoutes>[0]);
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await routes.patch(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
  return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]), store, group };
}

describe("room read boundary", () => {
  it("persists a viewed reply boundary without clearing later unread replies", async () => {
    const { status, body, group } = await patchRead({ readAt: 11 });
    expect(status).toBe(200);
    expect(body.group).toMatchObject({ readAt: 11, unread: true });
    const reloaded = new Store(() => ({ instanceId: "fake", model: "m" }));
    expect(reloaded.group(group.id)).toMatchObject({ readAt: 11, unread: true });
  });

  it.each([null, "11", {}])("rejects a nonnumeric read boundary %j", async (readAt) => {
    const { status, body, group } = await patchRead({ readAt });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "readAt must be a time in ms" });
    expect(group.readAt).toBeUndefined();
  });
});
