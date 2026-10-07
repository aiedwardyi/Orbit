import { request } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame, mintInvite, signAuth } from "../../shared/relay-protocol.ts";
import { signEnrollment } from "../src/enroll.ts";
import { createLogger, sanitize } from "../src/log.ts";
import {
  FrameReader,
  closed,
  connectRelay,
  event,
  makePc,
  openControl,
  openData,
  startRelay,
  type Harness,
} from "./fixtures.ts";
import { phoneConnect, serveInner } from "./pc-side.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ALLOWED = new Set([
  "t",
  "event",
  "label",
  "peer",
  "reason",
  "code",
  "route",
  "alpn",
  "bytesIn",
  "bytesOut",
  "durationMs",
  "count",
  "limit",
  "notAfter",
]);

function post(h: Harness, path: string, body: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: h.port,
        servername: `relay.${h.base}`,
        ca: h.ca.certPem,
        method: "POST",
        path,
        agent: false,
        headers: { host: `relay.${h.base}`, "content-type": "application/json", cookie },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("log sink", () => {
  it("never receives payload bytes, cookies, keys, invites, tickets or auth frames", async () => {
    h = await startRelay();
    const secrets: string[] = [];
    const pc = makePc();
    secrets.push(pc.pk, pc.privateKey.export({ format: "pem", type: "pkcs8" }).toString());

    // Enrollment with a cookie header carrying a secret.
    const invite = mintInvite(h.operator);
    const sig = signEnrollment(pc.privateKey, invite, pc.pk);
    const cookie = "__Host-wink_phone=wkd_COOKIESECRET0123456789";
    secrets.push(invite, sig, "COOKIESECRET0123456789");
    expect(await post(h, "/v1/enroll", JSON.stringify({ invite, pk: pc.pk, sig }), cookie)).toBe(200);
    // Replay and a garbage body also log, still without secrets.
    expect(await post(h, "/v1/enroll", JSON.stringify({ invite, pk: pc.pk, sig }), cookie)).toBe(409);

    // Control auth, including a failing attempt whose frame carries secrets.
    const ctl = await openControl(h, pc);
    secrets.push(ctl.ready.session, ctl.ready.poolToken);
    const bad = await connectRelay(h, "wink-ctl/1");
    const badReader = new FrameReader(bad);
    const hello = await badReader.next();
    if (hello?.type !== "hello") throw new Error("no hello");
    const forged = "wkt1.FORGEDTICKETSECRET.sig";
    secrets.push(hello.nonce, forged, signAuth(pc.privateKey, hello.nonce, pc.label));
    bad.write(
      encodeFrame({ type: "auth", label: pc.label, pk: pc.pk, ticket: forged, sig: signAuth(pc.privateKey, hello.nonce, pc.label) }),
    );
    await closed(bad);

    // A phone session with marked payload in both directions.
    const pcCert = await h.ca.issue(`${pc.label}.${h.base}`);
    secrets.push(pcCert.key);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));
    const inner = serveInner(data, pcCert);
    const phone = await phoneConnect(h, pc.label);
    const pcSide = await inner;
    const up = "PAYLOAD-UP-SECRET-Authorization: Bearer abc";
    const down = "PAYLOAD-DOWN-SECRET-Set-Cookie: x=y";
    secrets.push(up, down);
    pcSide.on("data", () => pcSide.write(down));
    phone.write(up);
    await new Promise<void>((resolve) => phone.once("data", () => resolve()));
    phone.end();
    await h.waitLog(event("splice-end", { label: pc.label }));
    ctl.socket.destroy();
    await h.waitLog(event("session-down", { label: pc.label }));

    expect(h.logs.length).toBeGreaterThan(5);
    const all = h.logs.join("\n");
    for (const secret of secrets) {
      for (const probe of [secret, secret.slice(0, 16), secret.slice(-16)]) expect(all).not.toContain(probe);
    }
    for (const line of h.logs) {
      expect(line.length).toBeLessThan(400);
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(entry)) expect(ALLOWED.has(key)).toBe(true);
      // Peers are /24 prefixes, never a full address.
      if (entry.peer !== undefined) expect(entry.peer).toMatch(/\/(24|48)$/);
    }
  });

  it("drops unknown keys and redacts values that do not fit their field", () => {
    const ticket = "wkt1.eyJsYWJlbCI6ImFiYyJ9.c2lnbmF0dXJl";
    const pk = "x".repeat(43);
    expect(
      sanitize({
        label: pk,
        reason: ticket,
        code: "Bearer abc",
        peer: "10.1.2.3",
        bytesIn: 12.4,
        ...({ cookie: "a=b", payload: "secret" } as object),
      }),
    ).toEqual({ label: "[redacted]", reason: "[redacted]", code: "[redacted]", peer: "[redacted]", bytesIn: 12 });
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.log("Not An Event!", { reason: "ok" });
    expect(JSON.parse(lines[0])).toMatchObject({ event: "invalid-event", reason: "ok" });
  });
});
