import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal PNG decoder: 8-bit, non-interlaced, truecolour (+alpha). No deps. */
function decodePng(path) {
  const bytes = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      colorType = bytes[offset + 17];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * channels);
  let pos = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const current = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      let value = current[x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) {
        const upperLeft = x >= channels ? previous[x - channels] : 0;
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
        value = (value + predictor) & 255;
      }
      row[x] = value;
    }
    row.copy(pixels, y * stride);
    previous = row;
  }
  return { width, height, channels, pixels };
}

function rgba(image, x, y) {
  const i = (y * image.width + x) * image.channels;
  return [
    image.pixels[i],
    image.pixels[i + 1],
    image.pixels[i + 2],
    image.channels === 4 ? image.pixels[i + 3] : 255,
  ];
}

const SHIPPED_PNGS = [
  "build/icon-1024.png",
  "build/icon.iconset/icon_16x16.png",
  "build/icon.iconset/icon_16x16@2x.png",
  "build/icon.iconset/icon_32x32.png",
  "build/icon.iconset/icon_32x32@2x.png",
  "build/icon.iconset/icon_64x64.png",
  "build/icon.iconset/icon_64x64@2x.png",
  "build/icon.iconset/icon_128x128.png",
  "build/icon.iconset/icon_128x128@2x.png",
  "build/icon.iconset/icon_256x256.png",
  "build/icon.iconset/icon_256x256@2x.png",
  "build/icon.iconset/icon_512x512.png",
  "build/icon.iconset/icon_512x512@2x.png",
  "electron/resources/app-icon.png",
];

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
