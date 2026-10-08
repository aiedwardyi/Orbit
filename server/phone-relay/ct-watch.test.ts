import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer } from "node:https";
import { afterEach, describe, expect, it } from "vitest";

import { relayProblem } from "../phone-auth.ts";
import { CT_FIRST_CHECK_MS, CT_INTERVAL_MS, CT_MAX_CERTS_PER_RUN, CtWatch, crtShSource, type CtSource } from "./ct-watch.ts";
import { rememberCertKey, spkiFingerprint } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { loopbackLookup } from "./testing/fake-relay.ts";
import { tempDataDir } from "./testing/harness.ts";
import { listenLocal } from "./testing/net.ts";
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

  it("reports a logged wildcard certificate that covers this host", async () => {
    const ca = await TestCa.create();
    const site = await ca.issue("crt.sh");
    const mine = await ca.issue(HOST);
    const rogue = await ca.issue("*.wink.test");
    const logged = new Map([[1, mine.certPem], [2, rogue.certPem]]);
    // Like crt.sh: q matches a logged name exactly, % is a LIKE wildcard.
    const server = createServer({ key: site.keyPem, cert: site.certPem }, (req, res) => {
      const url = new URL(req.url ?? "/", "https://crt.sh");
      const q = url.searchParams.get("q");
      const pem = logged.get(Number(url.searchParams.get("d")));
      if (q === null) return res.writeHead(pem ? 200 : 404).end(pem ?? "");
      const like = new RegExp(`^${q.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
      const ids = [...logged]
        .filter(([, cert]) => (new X509Certificate(cert).subjectAltName ?? "").split(", ").some((name) => like.test(name.replace(/^DNS:/, ""))))
        .map(([id]) => ({ id }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ids));
    });
    const port = await listenLocal(server);
    cleanups.push(() => server.close());
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    remember(dir, mine);
    const alerts: string[] = [];
    const source = crtShSource({ ca: ca.certPem, port, lookup: loopbackLookup });
    const watch = new CtWatch({ host: HOST, dataDir: dir, clock: new FakeClock(), source, onAlert: (message) => alerts.push(message) });
    cleanups.push(() => watch.stop());
    expect((await watch.run()).kind).toBe("alert");
    expect(alerts).toHaveLength(1);
  });

  it("classifies every alert as a Settings certificate warning", async () => {
    const ca = await TestCa.create();
    for (const [kind, name] of [["wildcard", "*.wink.test"], ["unknown key", HOST]] as const) {
      const { watch, alerts } = await setup(new Map([[1, (await ca.issue(name)).certPem]]));
      expect((await watch.run()).kind, kind).toBe("alert");
      expect(alerts, kind).toHaveLength(1);
      expect(relayProblem("connected", alerts[0]!), kind).toBe("unknown-certificate");
    }
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
