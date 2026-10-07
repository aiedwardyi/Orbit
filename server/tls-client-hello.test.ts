import { connect } from "node:tls";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from "../shared/tls-client-hello.ts";

/** Real ClientHello bytes from Node's TLS client, written into an in-memory Duplex. */
function captureClientHello(options: { servername?: string; ALPNProtocols?: string[] }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wire = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        resolve(Buffer.from(chunk));
        callback();
        process.nextTick(() => socket.destroy());
      },
    });
    const socket = connect({ socket: wire, ...options });
    socket.on("error", () => {});
    wire.on("error", reject);
  });
}

/** Re-wraps the handshake bytes of `hello` into records of at most `size` bytes. */
function splitRecords(hello: Buffer, size: number): Buffer {
  const handshake = hello.subarray(5, 5 + hello.readUInt16BE(3));
  const out: Buffer[] = [];
  for (let at = 0; at < handshake.length; at += size) {
    const part = handshake.subarray(at, at + size);
    const head = Buffer.from([22, 3, 1, 0, 0]);
    head.writeUInt16BE(part.length, 3);
    out.push(head, part);
  }
  return Buffer.concat(out);
}

/** Feeds `bytes` in reads of `step` bytes; every prefix short of the end must ask for more. */
function feed(bytes: Buffer, step: number) {
  for (let end = step; end < bytes.length; end += step) {
    expect(parseClientHello(bytes.subarray(0, end))).toBe("more");
  }
  return parseClientHello(bytes);
}

/** Deterministic PRNG so fuzz failures replay. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("parseClientHello", () => {
  it("reads SNI and ALPN from a real Node ClientHello", async () => {
    const hello = await captureClientHello({
      servername: "Abcdefghijklmnop.Wink.Example",
      ALPNProtocols: ["acme-tls/1", "http/1.1"],
    });
    expect(hello[0]).toBe(22);
    expect(parseClientHello(hello)).toEqual({
      sni: "abcdefghijklmnop.wink.example",
      alpn: ["acme-tls/1", "http/1.1"],
    });
  });

  it("handles the same hello spread over many records and reads", async () => {
    const hello = await captureClientHello({ servername: "relay.wink.example", ALPNProtocols: ["wink-ctl/1"] });
    const expected = { sni: "relay.wink.example", alpn: ["wink-ctl/1"] };
    expect(feed(hello, 1)).toEqual(expected);
    for (const size of [1, 3, 7, 64, 200]) {
      const split = splitRecords(hello, size);
      for (const step of [1, 5, 13, 100]) expect(feed(split, step)).toEqual(expected);
    }
  });

  it("reports a hello without SNI or ALPN", async () => {
    const hello = await captureClientHello({});
    expect(parseClientHello(hello)).toEqual({ sni: null, alpn: [] });
  });

  it("ignores bytes after the hello in the same read", async () => {
    const hello = await captureClientHello({ servername: "relay.wink.example" });
    const result = parseClientHello(Buffer.concat([hello, Buffer.from([23, 3, 3, 0, 1, 0])]));
    expect(result).toEqual({ sni: "relay.wink.example", alpn: [] });
  });

  it("asks for more on an empty buffer", () => {
    expect(parseClientHello(Buffer.alloc(0))).toBe("more");
  });

  it("rejects a first byte that is not a handshake record", () => {
    expect(parseClientHello(Buffer.from("GET / HTTP/1.1\r\n"))).toBe("invalid");
    expect(parseClientHello(Buffer.from([0x80]))).toBe("invalid");
    expect(parseClientHello(Buffer.from([23, 3, 3, 0, 5]))).toBe("invalid");
  });

  it("rejects garbage behind a handshake byte", () => {
    expect(parseClientHello(Buffer.from([22, 9]))).toBe("invalid");
    expect(parseClientHello(Buffer.from([22, 3, 1, 0, 0]))).toBe("invalid");
    expect(parseClientHello(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]))).toBe("invalid");
  });

  it("rejects a hello over 16 KiB", async () => {
    // Declared handshake length larger than the cap: rejected from the header alone.
    const declared = Buffer.from([22, 3, 1, 0x40, 0x00, 1, 0x00, 0x40, 0x00]);
    expect(parseClientHello(declared)).toBe("invalid");
    // Records that never complete a hello within the cap.
    const hello = await captureClientHello({ servername: "relay.wink.example" });
    const tooBig = Buffer.alloc(MAX_CLIENT_HELLO_BYTES + 100);
    const head = hello.subarray(0, 9);
    head.copy(tooBig);
    tooBig.writeUInt16BE(MAX_CLIENT_HELLO_BYTES, 3);
    tooBig[6] = 0x40;
    expect(parseClientHello(tooBig)).toBe("invalid");
  });

  it("never throws on truncated or bit-flipped hellos", async () => {
    const hello = await captureClientHello({
      servername: "abcdefghijklmnop.wink.example",
      ALPNProtocols: ["http/1.1"],
    });
    const corpus = [hello, splitRecords(hello, 11)];
    const random = rng(42);
    for (let i = 0; i < 5000; i++) {
      const base = corpus[i % corpus.length];
      const bytes = Buffer.from(base.subarray(0, 1 + Math.floor(random() * base.length)));
      const flips = Math.floor(random() * 4);
      for (let f = 0; f < flips; f++) bytes[Math.floor(random() * bytes.length)] ^= 1 << Math.floor(random() * 8);
      const result = parseClientHello(bytes);
      if (result === "more" || result === "invalid") continue;
      expect(result.sni === null || /^[a-z0-9._-]+$/.test(result.sni)).toBe(true);
      expect(Array.isArray(result.alpn)).toBe(true);
    }
    for (let i = 0; i < 2000; i++) {
      const junk = Buffer.alloc(1 + Math.floor(random() * 600));
      for (let j = 0; j < junk.length; j++) junk[j] = Math.floor(random() * 256);
      if (random() < 0.5) junk[0] = 22;
      expect(() => parseClientHello(junk)).not.toThrow();
    }
  });
});
