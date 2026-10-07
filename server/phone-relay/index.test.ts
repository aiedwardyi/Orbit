import { describe, expect, it } from "vitest";

import { startPhoneRelay } from "./index.ts";

describe("startPhoneRelay stub", () => {
  it("reports off and stops cleanly", async () => {
    const seen: unknown[] = [];
    const relay = startPhoneRelay({
      dataDir: "/nonexistent",
      config: { base: "wink.example", enabled: true },
      handler: () => {},
      onStatus: (status) => seen.push(status),
    });
    expect(relay.status().state).toBe("off");
    await relay.stop();
    expect(seen).toEqual([]);
  });
});
