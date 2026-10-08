import { afterEach, describe, expect, it } from "vitest";

import { relayProblem } from "../phone-auth.ts";
import { CtWatch } from "./ct-watch.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { tempDataDir } from "./testing/harness.ts";
import { TestCa } from "./testing/pki.ts";

const HOST = "abcdefghijklmnop.wink.test";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("relay audit: CT warning delivery", () => {
  it("classifies a detected wildcard certificate as a Settings security warning", async () => {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const certificate = await ca.issue("*.wink.test");
    const alerts: string[] = [];
    const watch = new CtWatch({
      host: HOST,
      dataDir: dir,
      clock: new FakeClock(),
      source: {
        list: async (host) => host === "*.wink.test" ? [1] : [],
        fetch: async () => certificate.certPem,
      },
      onAlert: (message) => alerts.push(message),
    });
    cleanups.push(() => watch.stop());
    expect((await watch.run()).kind).toBe("alert");
    expect(alerts).toHaveLength(1);
    expect(relayProblem("connected", alerts[0]!)).toBe("unknown-certificate");
  });
});
