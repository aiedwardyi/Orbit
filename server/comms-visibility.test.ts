// The bot⇄bot channel a peer exchange mirrors into. A pair channel is a
// real room in the sidebar: the user can rename it, file it, and talk in
// it, so ask_bot must not quietly move it out from under them.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { getOrCreateChannel } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("getOrCreateChannel", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Atlas", section: "Launch" })!;
    target = store.patchBot(store.createBot().id, { name: "Helper", section: "Launch" })!;
  });

  it("files a new pair channel under the sender's section", () => {
    const channel = getOrCreateChannel(store, from, target);

    expect(channel.name).toBe("Atlas ⇄ Helper");
    expect(channel.section).toBe("Launch");
  });

  it("keeps a channel the user renamed and filed where they put it", () => {
    const channel = getOrCreateChannel(store, from, target);
    store.patchGroup(channel.id, { name: "PR 39 triage", section: "Archive" });

    const moved = store.patchBot(from.id, { section: "Ops" })!;
    const movedTarget = store.patchBot(target.id, { section: "Ops" })!;
    const reused = getOrCreateChannel(store, moved, movedTarget);

    expect(reused.id).toBe(channel.id);
    expect(reused.name).toBe("PR 39 triage");
    expect(reused.section).toBe("Archive");
  });
});
