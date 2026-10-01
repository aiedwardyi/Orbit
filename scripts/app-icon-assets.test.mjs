import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SHIPPED_PNGS } from "./generate-app-icon.mjs";
import { decodePng, encodePng } from "./png-codec.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function rgba(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2], image.pixels[i + 3]];
}

/** A real 2x2 grayscale (non-RGBA) PNG, built by hand with no image deps. */
function grayPng() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (body) => {
    let c = -1;
    for (const byte of body) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    const out = Buffer.alloc(4);
    out.writeUInt32BE((c ^ -1) >>> 0);
    return out;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    return Buffer.concat([length, body, crc(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // grayscale, no alpha
  const raw = Buffer.from([0, 10, 20, 0, 30, 40]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("app icon assets", () => {
  it("keeps every shipped PNG corner fully transparent", () => {
    for (const relative of SHIPPED_PNGS) {
      const image = decodePng(join(ROOT, relative));
      for (const [x, y] of [
        [0, 0],
        [image.width - 1, 0],
        [0, image.height - 1],
        [image.width - 1, image.height - 1],
      ]) {
        const [, , , alpha] = rgba(image, x, y);
        expect(alpha, `${relative} corner (${x},${y})`).toBe(0);
      }
      const center = rgba(image, image.width >> 1, image.height >> 1);
      expect(center[3], `${relative} center alpha`).toBe(255);
    }
  });

  it("validates the shipped files through the generator --check branch", () => {
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/generate-app-icon.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(output).toContain("ok build/icon-1024.png");
    expect(output).not.toContain("FAIL");
  });

  it("rejects a non-RGBA source loudly instead of mis-decoding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-icon-reject-"));
    try {
      const gray = join(dir, "gray.png");
      writeFileSync(gray, grayPng());
      expect(() => decodePng(gray)).toThrow(/only non-interlaced 8-bit RGBA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a master that is not exactly 1024x1024 before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-icon-size-"));
    try {
      const small = join(dir, "small.png");
      writeFileSync(
        small,
        encodePng({ width: 64, height: 64, pixels: Buffer.alloc(64 * 64 * 4, 255) }),
      );
      let error = null;
      try {
        execFileSync(process.execPath, [join(ROOT, "scripts/generate-app-icon.mjs"), "--source", small], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (failure) {
        error = failure;
      }
      expect(error, "expected a nonzero exit").not.toBeNull();
      expect(error.status).not.toBe(0);
      expect(String(error.stderr)).toContain("must be exactly 1024x1024 RGBA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paints the vector sources in the Wink prompt artwork", () => {
    for (const relative of ["build/icon.svg", "public/app-icon.svg"]) {
      const svg = readFileSync(join(ROOT, relative), "utf8").toLowerCase();
      expect(svg, `${relative} tile top`).toContain("#1f2747");
      expect(svg, `${relative} tile bottom`).toContain("#0a0e19");
      expect(svg, `${relative} chevron`).toContain("#ff4d9d");
      expect(svg, `${relative} cursor`).toContain("#ffd447");
      expect(svg, `${relative} rim`).toContain("#323b5c");
      expect(svg, `${relative} title`).toContain("<title id=\"title\">wink</title>");
      expect(svg, `${relative} stale base`).not.toContain("#2b1d1a");
      expect(svg, `${relative} stale ring`).not.toContain("#ff9e64");
      expect(svg, `${relative} inset tile`).toContain('x="12"');
    }
  });

  it("draws 16-32px Windows frames from the small-size artwork", () => {
    const ico = readFileSync(join(ROOT, "build/icon.ico"));
    const frames = new Map();
    for (let index = 0; index < ico.readUInt16LE(4); index++) {
      const entry = 6 + index * 16;
      const size = ico[entry] || 256;
      const offset = ico.readUInt32LE(entry + 12);
      frames.set(size, ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)));
    }
    expect([...frames.keys()].sort((a, b) => a - b)).toEqual([16, 20, 32, 48, 64, 128, 256]);
    const dir = mkdtempSync(join(tmpdir(), "omb-icon-ico-"));
    try {
      for (const size of [16, 20, 32]) {
        const path = join(dir, `${size}.png`);
        writeFileSync(path, frames.get(size));
        const image = decodePng(path);
        // The small art's tile runs to the edge; the large art keeps a 12/256 transparent margin.
        expect(rgba(image, size >> 1, 0)[3], `${size} top edge alpha`).toBeGreaterThan(200);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the maskable PWA icon opaque and full-bleed", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.json"), "utf8"));
    const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
    expect(maskable.src.split("?")[0]).toBe("/app-icon-maskable-512.png");
    const bytes = readFileSync(join(ROOT, "public/app-icon-maskable-512.png"));
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
    // Opaque RGB: a launcher mask may crop anywhere, so no transparent corner may show.
    expect(bytes[25], "color type").toBe(2);
  });

  it("versions every PWA icon URL the same way", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    const manifest = readFileSync(join(ROOT, "public/manifest.json"), "utf8");
    const worker = readFileSync(join(ROOT, "public/sw.js"), "utf8");
    const versions = [html, manifest, worker].flatMap((text) =>
      [...text.matchAll(/\/app-icon[\w-]*\.(?:png|svg)(\?v=\w+)?/g)].map((match) => match[1]),
    );
    expect(versions.length).toBe(6);
    expect(new Set(versions)).toEqual(new Set(["?v=2"]));
  });
});
