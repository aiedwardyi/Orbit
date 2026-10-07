/**
 * Reads SNI and ALPN from the first bytes of a TLS connection without
 * decrypting anything. Used by the relay router and the PC ingress
 * (docs/phone-relay-design.md sections 5 and 6).
 *
 * Pure function: call it again with the grown buffer after every read.
 */

export const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

export interface ClientHelloInfo {
  /** Lowercased host_name, or null when the client sent no SNI. */
  sni: string | null;
  /** ALPN protocol ids in client order, empty when not offered. */
  alpn: string[];
}

const RECORD_HEADER = 5;
const CONTENT_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const MAX_RECORD_PAYLOAD = 16 * 1024;
const EXT_SERVER_NAME = 0;
const EXT_ALPN = 16;
const HOST_RE = /^[a-z0-9._-]{1,255}$/;

/**
 * "more": a valid prefix, read more bytes. "invalid": not a TLS ClientHello,
 * malformed, or not complete within MAX_CLIENT_HELLO_BYTES.
 */
export function parseClientHello(buf: Uint8Array): ClientHelloInfo | "more" | "invalid" {
  if (buf.length === 0) return "more";
  if (buf[0] !== CONTENT_HANDSHAKE) return "invalid";

  // Reassemble the handshake message from as many records as it spans.
  const parts: Uint8Array[] = [];
  let have = 0;
  let need = -1;
  let offset = 0;
  for (;;) {
    if (need >= 0 && have >= need) break;
    if (buf.length - offset < RECORD_HEADER) {
      if (!headerPrefixOk(buf, offset)) return "invalid";
      return buf.length >= MAX_CLIENT_HELLO_BYTES ? "invalid" : "more";
    }
    if (buf[offset] !== CONTENT_HANDSHAKE || buf[offset + 1] !== 3) return "invalid";
    const length = (buf[offset + 3] << 8) | buf[offset + 4];
    if (length === 0 || length > MAX_RECORD_PAYLOAD) return "invalid";
    const end = offset + RECORD_HEADER + length;
    if (end > MAX_CLIENT_HELLO_BYTES) return "invalid";
    if (end > buf.length) {
      // Partial record: its bytes still let us reject early on the handshake header.
      const partial = joined(parts, have, buf.subarray(offset + RECORD_HEADER));
      if (!handshakeHeaderOk(partial)) return "invalid";
      return "more";
    }
    parts.push(buf.subarray(offset + RECORD_HEADER, end));
    have += length;
    offset = end;
    if (need < 0 && have >= 4) {
      const head = joined(parts, have);
      if (!handshakeHeaderOk(head)) return "invalid";
      need = 4 + ((head[1] << 16) | (head[2] << 8) | head[3]);
    }
  }
  // Another handshake message may not share the records after the ClientHello.
  if (have !== need) return "invalid";
  return parseBody(joined(parts, have).subarray(4));
}

function headerPrefixOk(buf: Uint8Array, offset: number): boolean {
  if (offset < buf.length && buf[offset] !== CONTENT_HANDSHAKE) return false;
  if (offset + 1 < buf.length && buf[offset + 1] !== 3) return false;
  return true;
}

function handshakeHeaderOk(head: Uint8Array): boolean {
  if (head.length >= 1 && head[0] !== HANDSHAKE_CLIENT_HELLO) return false;
  if (head.length >= 4) {
    const length = (head[1] << 16) | (head[2] << 8) | head[3];
    if (length === 0 || 4 + length > MAX_CLIENT_HELLO_BYTES) return false;
  }
  return true;
}

function joined(parts: Uint8Array[], size: number, tail?: Uint8Array): Uint8Array {
  const all = tail ? [...parts, tail] : parts;
  if (all.length === 1) return all[0];
  const out = new Uint8Array(size + (tail?.length ?? 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

class Reader {
  at = 0;
  constructor(private readonly buf: Uint8Array, private readonly end = buf.length) {}
  get left(): number {
    return this.end - this.at;
  }
  u8(): number {
    if (this.left < 1) throw RangeError();
    return this.buf[this.at++];
  }
  u16(): number {
    if (this.left < 2) throw RangeError();
    const v = (this.buf[this.at] << 8) | this.buf[this.at + 1];
    this.at += 2;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.left < n) throw RangeError();
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** Reader over the next `n` bytes; this reader skips past them. */
  sub(n: number): Reader {
    if (this.left < n) throw RangeError();
    const r = new Reader(this.buf, this.at + n);
    r.at = this.at;
    this.at += n;
    return r;
  }
}

function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function parseBody(body: Uint8Array): ClientHelloInfo | "invalid" {
  try {
    const r = new Reader(body);
    if (r.u8() !== 3) return "invalid"; // legacy_version major
    r.u8();
    r.bytes(32); // random
    const sessionId = r.u8();
    if (sessionId > 32) return "invalid";
    r.bytes(sessionId);
    const suites = r.u16();
    if (suites < 2 || suites % 2 !== 0) return "invalid";
    r.bytes(suites);
    const compression = r.u8();
    if (compression < 1) return "invalid";
    r.bytes(compression);

    const info: ClientHelloInfo = { sni: null, alpn: [] };
    if (r.left === 0) return info; // no extensions block
    const exts = r.sub(r.u16());
    if (r.left !== 0) return "invalid";
    const seen = new Set<number>();
    while (exts.left > 0) {
      const type = exts.u16();
      const data = exts.sub(exts.u16());
      if (seen.has(type)) return "invalid";
      seen.add(type);
      if (type === EXT_SERVER_NAME) {
        const sni = readServerName(data);
        if (sni === "invalid") return sni;
        info.sni = sni;
      } else if (type === EXT_ALPN) {
        const alpn = readAlpn(data);
        if (alpn === "invalid") return alpn;
        info.alpn = alpn;
      }
    }
    return info;
  } catch (error) {
    if (error instanceof RangeError) return "invalid";
    throw error;
  }
}

function readServerName(data: Reader): string | null | "invalid" {
  // A server may receive an empty server_name extension only in its own reply.
  if (data.left === 0) return null;
  const list = data.sub(data.u16());
  if (data.left !== 0 || list.left === 0) return "invalid";
  let host: string | null = null;
  while (list.left > 0) {
    const nameType = list.u8();
    const name = list.bytes(list.u16());
    if (nameType !== 0) continue;
    if (host !== null) return "invalid";
    host = ascii(name).toLowerCase();
    if (!HOST_RE.test(host)) return "invalid";
  }
  return host;
}

function readAlpn(data: Reader): string[] | "invalid" {
  const list = data.sub(data.u16());
  if (data.left !== 0 || list.left === 0) return "invalid";
  const out: string[] = [];
  while (list.left > 0) {
    const id = list.bytes(list.u8());
    if (id.length === 0) return "invalid";
    out.push(ascii(id));
  }
  return out;
}
