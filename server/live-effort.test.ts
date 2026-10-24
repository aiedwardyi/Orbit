import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createBotRoutes } from "./bot-routes.ts";
import { EFFORT_LEVELS, type ModelSelection, type ProviderAdapter } from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { Store } from "./store.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

const running: ModelSelection = { instanceId: "engine", model: "fake-1", mode: "pinned", effort: "max" };
const high: ModelSelection = { ...running, effort: "high" };
const pickSchema = z.object({
  instanceId: z.string(),
  model: z.string(),
  mode: z.enum(["automatic", "pinned"]).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function harness(busy: boolean, applyEffort?: ProviderAdapter["applyEffort"]) {
  const store = new Store(() => running);
  const bot = store.createBot({ name: "Ada", modelSelection: running });
  if (busy) store.setActivity(bot.id, "working", bot.threadId);
  const registry = new ProviderRegistry([makeFakeDriver().driver]);
  await registry.load({ engine: { driver: "fake" } });
  if (applyEffort) registry.get("engine")!.adapter.applyEffort = applyEffort;
  const deps: Partial<Parameters<typeof createBotRoutes>[0]> = {
    store,
    registry,
    checkedModelSelection: (raw) => ({ ok: true, selection: pickSchema.parse(raw) }),
    wireBot: (record) => ({ ...record }),
  };
  // SAFETY: a PATCH that carries only modelSelection reads no other dep.
  const routes = createBotRoutes(deps as Parameters<typeof createBotRoutes>[0]);
  const listening = createServer((req, res) => void routes.patch(req, res, /^\/api\/bots\/([^/]+)$/.exec(req.url ?? "")!));
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  // SAFETY: the server was bound to TCP above, not to a pipe.
  const { port } = listening.address() as AddressInfo;
  const pick = async (selection: ModelSelection) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSelection: selection }),
    });
    expect(res.status).toBe(200);
    return store.bot(bot.id)!;
  };
  return { pick, threadId: bot.threadId };
}

describe("effort pick on a busy bot", () => {
  it("commits at once when the running turn takes the new effort", async () => {
    const applyEffort = vi.fn(async () => true);
    const { pick, threadId } = await harness(true, applyEffort);
    const bot = await pick(high);
    expect(bot.modelSelection).toEqual(high);
    expect(bot.pendingModelSelection).toBeUndefined();
    expect(applyEffort).toHaveBeenCalledWith(threadId, "high");
  });

  it.each([
    ["refuses", async () => false],
    ["throws", async () => Promise.reject(new Error("closed"))],
  ])("holds the pick for the turn end when the engine %s", async (_, answer) => {
    const applyEffort = vi.fn(answer);
    const { pick, threadId } = await harness(true, applyEffort);
    const bot = await pick(high);
    expect(applyEffort).toHaveBeenCalledWith(threadId, "high");
    expect(bot.modelSelection).toEqual(running);
    expect(bot.pendingModelSelection).toEqual(high);
  });

  it("holds the pick when the engine has no live effort path", async () => {
    const { pick } = await harness(true);
    const bot = await pick(high);
    expect(bot.modelSelection).toEqual(running);
    expect(bot.pendingModelSelection).toEqual(high);
  });

  it("still holds a model change", async () => {
    const applyEffort = vi.fn(async () => true);
    const { pick } = await harness(true, applyEffort);
    const other = { ...high, model: "fake-2" };
    const bot = await pick(other);
    expect(applyEffort).not.toHaveBeenCalled();
    expect(bot.modelSelection).toEqual(running);
    expect(bot.pendingModelSelection).toEqual(other);
  });

  it("applies on an idle bot as before, without the engine", async () => {
    const applyEffort = vi.fn(async () => true);
    const { pick } = await harness(false, applyEffort);
    const bot = await pick(high);
    expect(applyEffort).not.toHaveBeenCalled();
    expect(bot.modelSelection).toEqual(high);
    expect(bot.pendingModelSelection).toBeUndefined();
  });
});
