import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SHIPPED_PNGS } from "./generate-app-icon.mjs";
import { decodePng } from "./png-codec.mjs";

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

  it("paints the vector sources in the new slate/cream/green artwork", () => {
    for (const relative of ["build/icon.svg", "public/app-icon.svg"]) {
      const svg = readFileSync(join(ROOT, relative), "utf8").toLowerCase();
      expect(svg, `${relative} base`).toContain("#303446");
      expect(svg, `${relative} ring`).toContain("#a6d189");
      expect(svg, `${relative} stale spectrum`).not.toContain("#1688ff");
      expect(svg, `${relative} stale magenta`).not.toContain("#f45aa8");
      expect(svg, `${relative} full-bleed background`).not.toContain('width="1024"');
    }
  });
});
