import { describe, expect, it } from "vitest";

import {
  PHONE_COOKIE,
  RateLimiter,
  enrollError,
  phoneCookieToken,
  phoneSetCookie,
  rateKey,
  refuseVpsJoin,
  relayProblem,
  relayVerdict,
  requestCredentials,
  safeRelayError,
  shellNavigation,
} from "./phone-auth.ts";

const HOST = "abcdefghijklmnop.wink.test";
const ORIGIN = `https://${HOST}`;

function req(method: string, url: string, headers: Array<[string, string]> = [["host", HOST]]) {
  return { method, url, rawHeaders: headers.flat() };
}

const verdict = (method: string, url: string, headers?: Array<[string, string]>) => relayVerdict(req(method, url, headers), HOST);

describe("relay host gate", () => {
  it("accepts only this PC's relay host", () => {
    expect(verdict("GET", "/").kind).toBe("app");
    expect(verdict("GET", "/", [["Host", HOST.toUpperCase()]]).kind).toBe("app");
    for (const host of ["localhost", "127.0.0.1:8799", "home.tail396477.ts.net", `${HOST}:443`, `x.${HOST}`, "other1234567890a.wink.test"]) {
      expect(verdict("GET", "/api/bots", [["host", host]])).toEqual({ kind: "deny", status: 403, error: "forbidden: relay host required" });
    }
    expect(verdict("GET", "/", [])).toMatchObject({ kind: "deny", status: 403 });
  });

  it("rejects duplicate Host headers", () => {
    expect(verdict("GET", "/", [["host", HOST], ["host", HOST]])).toMatchObject({ kind: "deny", status: 400 });
  });

  it("rejects request targets that are not a plain path", () => {
    // "//" and "/\[" make WHATWG URL throw; "/\evil/x" parses as host "evil", path "/x".
    for (const url of ["http://localhost/api/bots", "//api/internal/agents", "*", "", "//", "/\\[", "/\\evil/api/internal/agents", "/a\\b"]) {
      expect(verdict("GET", url)).toMatchObject({ kind: "deny", status: 400 });
    }
  });
});

describe("relay origin gate", () => {
  it("lets a same-origin or origin-less read through", () => {
    expect(verdict("GET", "/api/bots", [["host", HOST], ["origin", ORIGIN]]).kind).toBe("app");
    expect(verdict("HEAD", "/api/bots").kind).toBe("app");
  });

  it("refuses a write without an Origin", () => {
    expect(verdict("POST", "/api/bots")).toEqual({ kind: "deny", status: 403, error: "forbidden: origin required" });
    expect(verdict("DELETE", "/api/bots/x")).toMatchObject({ kind: "deny", status: 403 });
  });

  it("refuses foreign, opaque, insecure and duplicate origins", () => {
    for (const origin of ["https://evil.example", "null", `http://${HOST}`, `${ORIGIN}:443`, `${ORIGIN}/`, "http://localhost:5199"]) {
      expect(verdict("POST", "/api/bots", [["host", HOST], ["origin", origin]])).toEqual({
        kind: "deny",
        status: 403,
        error: "forbidden: cross-origin request",
      });
    }
    expect(verdict("GET", "/", [["host", HOST], ["origin", ORIGIN], ["origin", ORIGIN]])).toMatchObject({ kind: "deny", status: 403 });
  });
});

describe("relay routes", () => {
  const withOrigin: Array<[string, string]> = [["host", HOST], ["origin", ORIGIN]];

  it("hides local-only and management routes", () => {
    const hidden = [
      "/api/mailbox",
      "/remote?key=abc",
      "/api/internal",
      "/api/internal/agents",
      "/api/internal/terminal-bridge",
      "/api/remote-link",
      "/api/phone/pairing",
      "/api/phone/devices",
      "/api/phone/devices/abc",
      "/api/phone/anything",
      "/api/phone-relay",
      "/api/phone-relay/status",
      "/api/phone-relay/enroll",
    ];
    for (const path of hidden) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(verdict(method, path, withOrigin), `${method} ${path}`).toEqual({ kind: "deny", status: 404, error: "not found" });
      }
    }
  });

  it("answers health, the pair page and pairing before auth", () => {
    expect(verdict("GET", "/api/health").kind).toBe("health");
    expect(verdict("HEAD", "/api/health").kind).toBe("health");
    expect(verdict("GET", "/pair").kind).toBe("pair-page");
    expect(verdict("POST", "/api/phone/pair", withOrigin).kind).toBe("pair");
    expect(verdict("GET", "/api/phone/pair", withOrigin)).toMatchObject({ kind: "deny", status: 404 });
  });

  it("leaves everything else to the app behind the phone session", () => {
    expect(verdict("GET", "/api/events").kind).toBe("app");
    expect(verdict("GET", "/api/threads/t1/linked-file?path=x").kind).toBe("app");
    expect(verdict("POST", "/api/health", withOrigin).kind).toBe("app");
  });
});

describe("phone cookie", () => {
  it("is host-only, secure, http-only, lax and lasts 400 days", () => {
    expect(phoneSetCookie("wkd_abc")).toBe("__Host-wink_phone=wkd_abc; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax");
    expect(phoneSetCookie("wkd_abc")).not.toMatch(/Domain/i);
  });

  it("reads exactly one phone cookie", () => {
    expect(phoneCookieToken(`theme=dark; ${PHONE_COOKIE}=wkd_abc`)).toBe("wkd_abc");
    expect(phoneCookieToken(` ${PHONE_COOKIE} = wkd_abc `)).toBe("wkd_abc");
    expect(phoneCookieToken(undefined)).toBeNull();
    expect(phoneCookieToken("wink_phone=wkd_abc; orbit_remote=k")).toBeNull();
    expect(phoneCookieToken(`${PHONE_COOKIE}=wkd_a; ${PHONE_COOKIE}=wkd_b`)).toBeNull();
    expect(phoneCookieToken(`${PHONE_COOKIE}=`)).toBeNull();
  });
});

describe("request credentials", () => {
  it("gives relay traffic only its phone session", () => {
    expect(requestCredentials(true, true, true, "key")).toEqual({ bearerOk: false, remoteKey: undefined, phoneSession: true });
    expect(requestCredentials(true, false, true, "key")).toEqual({ bearerOk: false, remoteKey: undefined, phoneSession: false });
  });

  it("ignores a phone session off the relay", () => {
    expect(requestCredentials(false, true, true, "key")).toEqual({ bearerOk: true, remoteKey: "key", phoneSession: false });
  });

  it("refuses VPS join through the relay whatever the headers say", () => {
    expect(refuseVpsJoin({}, true)).toBe(true);
    expect(refuseVpsJoin({ "x-openmausbot-companion": "0" }, true)).toBe(true);
    expect(refuseVpsJoin({ "x-openmausbot-companion": "1" }, false)).toBe(true);
    expect(refuseVpsJoin({}, false)).toBe(false);
  });
});

describe("shell navigation", () => {
  it("sends app pages to pairing and leaves files public", () => {
    for (const path of ["/", "/index.html", "/bots/abc", "/settings"]) expect(shellNavigation("GET", path), path).toBe(true);
    for (const path of ["/assets/index-abc.js", "/manifest.json", "/sw.js", "/offline.html", "/fonts/x.woff2", "/app-icon-192.png"]) {
      expect(shellNavigation("GET", path), path).toBe(false);
    }
    expect(shellNavigation("POST", "/")).toBe(false);
  });
});

describe("pairing rate limits", () => {
  it("allows a burst per key and refills over a minute", () => {
    let now = 0;
    const limiter = new RateLimiter(10, 60_000, () => now);
    for (let i = 0; i < 10; i++) expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    now += 6_000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("forgets the oldest key when full", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0, 2);
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("c")).toBe(false);
  });

  it("groups peers by address and IPv6 /64", () => {
    expect(rateKey("198.51.100.7")).toBe("198.51.100.7");
    expect(rateKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateKey("2001:db8:1:2:3:4:5:6")).toBe(rateKey("2001:db8:1:2::9"));
    expect(rateKey("2001:db8:1:2::9")).not.toBe(rateKey("2001:db8:1:3::9"));
    expect(rateKey(null)).toBe("unknown");
  });
});

describe("relay status for Settings", () => {
  it("keeps tokens and long secrets out of errors", () => {
    expect(safeRelayError(null)).toBeNull();
    const text = safeRelayError(`bad wkt1.eyJhbGciOi.c2ln wki1.abc.def wkd_${"a".repeat(43)} key ${"Z".repeat(40)} end`)!;
    expect(text).not.toMatch(/wkt1\.|wki1\.|wkd_|Z{40}/);
    expect(text).toContain("end");
    expect(safeRelayError("x".repeat(500))!.length).toBeLessThanOrEqual(200);
  });

  it("names the problems Settings explains", () => {
    expect(relayProblem("rejected", "superseded: this phone address is in use on another computer")).toBe("superseded");
    expect(relayProblem("rejected", "revoked: relay access removed, enter an invite")).toBe("revoked");
    expect(relayProblem("rejected", "ticket expired, enter an invite")).toBe("ticket-expired");
    expect(relayProblem("connected", "CT log shows a certificate for x with a key this PC never made (crt.sh id 1)")).toBe("unknown-certificate");
    expect(relayProblem("reconnecting", "connection to relay closed")).toBeNull();
  });

  it("names only the enrollment refusals a teammate can act on", () => {
    expect(enrollError("relay refused enrollment (409 invite-used)")).toBe("invite-used");
    expect(enrollError("relay refused enrollment (403 invite-expired)")).toBe("invite-expired");
    for (const reason of [
      "relay refused enrollment (403 invite-invalid)",
      "relay refused enrollment (429 rate-limited)",
      "relay refused enrollment (500)",
      "getaddrinfo ENOTFOUND relay.example.invalid",
    ]) {
      expect(enrollError(reason), reason).toBe("enroll-failed");
    }
  });
});
