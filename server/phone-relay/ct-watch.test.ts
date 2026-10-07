import { createPrivateKey } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { CT_FIRST_CHECK_MS, CT_INTERVAL_MS, CT_MAX_CERTS_PER_RUN, CtWatch, type CtSource } from "./ct-watch.ts";
import { rememberCertKey, spkiFingerprint } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { tempDataDir } from "./testing/harness.ts";
import { TestCa, type KeyAndCert } from "./testing/pki.ts";

const HOST = "abcdefghijklmnop.wink.test";

describe("certificate transparency watch", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function setup(entries: Map<number, string>, failing = false) {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const fetched: number[] = [];
    const source: CtSource = {
      list: async () => {
        if (failing) throw new Error("timed out");
        return [...entries.keys()];
      },
      fetch: async (id) => {
        fetched.push(id);
        const pem = entries.get(id);
        if (!pem) throw new Error("gone");
        return pem;
      },
    };
    const alerts: string[] = [];
    const clock = new FakeClock();
    const watch = new CtWatch({ host: HOST, dataDir: dir, clock, source, onAlert: (message) => alerts.push(message) });
    cleanups.push(() => watch.stop());
    return { dir, watch, alerts, fetched, clock };
  }

  function remember(dir: string, cert: KeyAndCert) {
    rememberCertKey(dir, spkiFingerprint(createPrivateKey(cert.keyPem)));
  }

  it("accepts certificates whose keys this PC made", async () => {
    const ca = await TestCa.create();
    const mine = await ca.issue(HOST);
    const { dir, watch, alerts } = await setup(new Map([[11, mine.certPem]]));
    remember(dir, mine);
    expect(await watch.run()).toEqual({ kind: "ok", checked: 1 });
    expect(alerts).toEqual([]);
  });

  it("reports a verified certificate with an unknown key", async () => {
    const ca = await TestCa.create();
    const mine = await ca.issue(HOST);
    const rogue = await ca.issue(HOST);
    const { dir, watch, alerts } = await setup(new Map([[11, mine.certPem], [12, rogue.certPem]]));
    remember(dir, mine);
    const result = await watch.run();
    expect(result.kind).toBe("alert");
    expect(alerts).toEqual([`CT log shows a certificate for ${HOST} with a key this PC never made (crt.sh id 12)`]);
  });

  it("ignores entries for other names and unreadable entries", async () => {
    const ca = await TestCa.create();
    const other = await ca.issue("zzzzzzzzzzzzzzzz.wink.test");
    const { watch, alerts } = await setup(new Map([[1, other.certPem], [2, "not a cert"]]));
    expect(await watch.run()).toEqual({ kind: "ok", checked: 0 });
    expect(alerts).toEqual([]);
  });

  it("treats a failed lookup as unavailable, not as an attack", async () => {
    const { watch, alerts } = await setup(new Map(), true);
    expect(await watch.run()).toEqual({ kind: "unavailable" });
    expect(alerts).toEqual([]);
  });

  it("bounds each run and does not refetch checked entries", async () => {
    const ca = await TestCa.create();
    const mine = await ca.issue(HOST);
    const entries = new Map<number, string>();
    for (let id = 1; id <= CT_MAX_CERTS_PER_RUN + 5; id++) entries.set(id, mine.certPem);
    const { dir, watch, fetched } = await setup(entries);
    remember(dir, mine);
    await watch.run();
    expect(fetched).toHaveLength(CT_MAX_CERTS_PER_RUN);
    await watch.run();
    expect(fetched).toHaveLength(CT_MAX_CERTS_PER_RUN + 5);
    await watch.run();
    expect(fetched).toHaveLength(CT_MAX_CERTS_PER_RUN + 5);
  });

  it("runs on its schedule and stops cleanly", async () => {
    const ca = await TestCa.create();
    const mine = await ca.issue(HOST);
    const { dir, watch, fetched, clock } = await setup(new Map([[5, mine.certPem]]));
    remember(dir, mine);
    watch.start();
    clock.advance(CT_FIRST_CHECK_MS - 1);
    expect(fetched).toEqual([]);
    clock.advance(1);
    await new Promise<void>((resolve) => {
      const check = () => (fetched.length === 1 ? resolve() : setImmediate(check));
      check();
    });
    watch.stop();
    clock.advance(CT_INTERVAL_MS * 3);
    expect(fetched).toEqual([5]);
  });
});
