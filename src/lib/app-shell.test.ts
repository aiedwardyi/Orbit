import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decodes an 8-bit truecolor(+alpha) PNG into a flat RGB pixel grid, undoing
// the per-scanline filter (PNG spec 9.2/9.3). No dependency: node:zlib covers
// the compression, this covers the (unrelated) predictive filtering.
function decodePngRgb(path: string): { width: number; height: number; pixelAt: (x: number, y: number) => string } {
  const buf = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} in ${path}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (channels === null) throw new Error(`unsupported PNG color type ${colorType} in ${path}`);
  const filtered = inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * channels;
  const recon = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filterType = filtered[y * (rowBytes + 1)];
    const rowIn = y * (rowBytes + 1) + 1;
    const rowOut = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const filt = filtered[rowIn + x];
      const a = x >= channels ? recon[rowOut + x - channels] : 0;
      const b = y > 0 ? recon[rowOut - rowBytes + x] : 0;
      const c = x >= channels && y > 0 ? recon[rowOut - rowBytes + x - channels] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = filt;
          break;
        case 1:
          value = filt + a;
          break;
        case 2:
          value = filt + b;
          break;
        case 3:
          value = filt + Math.floor((a + b) / 2);
          break;
        case 4:
          value = filt + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType} in ${path}`);
      }
      recon[rowOut + x] = value & 0xff;
    }
  }
  return {
    width,
    height,
    pixelAt: (x, y) => {
      const i = y * rowBytes + x * channels;
      const [r, g, b] = recon.subarray(i, i + 3);
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    },
  };
}

describe("home-screen app shell", () => {
  it("links a valid standalone manifest whose icons exist", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "Orbit", start_url: "/", display: "standalone" });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(join(root, "public", icon.src))).toBe(true);
  });

  it("blends the maskable icon's edge into the phone splash background, keeping art inside the safe zone", () => {
    const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"));
    const maskable = manifest.icons.find((icon: { purpose?: string }) => icon.purpose === "maskable");
    const png = decodePngRgb(join(root, "public", maskable.src));
    const bg = manifest.background_color.toLowerCase();
    expect(png.pixelAt(0, 0)).toBe(bg);

    // Android's maskable safe zone is the center circle of 80% diameter (radius 205px
    // of a 512px icon); art outside it can be clipped by the OS mask, so every corner
    // and every point on that circle's diagonals must still be plain background.
    const cx = png.width / 2;
    const cy = png.height / 2;
    const r = 0.4 * png.width;
    const points = [
      [60, 60],
      [png.width - 60, 60],
      [60, png.height - 60],
      [png.width - 60, png.height - 60],
      [cx - r / Math.SQRT2, cy - r / Math.SQRT2],
      [cx + r / Math.SQRT2, cy - r / Math.SQRT2],
      [cx - r / Math.SQRT2, cy + r / Math.SQRT2],
      [cx + r / Math.SQRT2, cy + r / Math.SQRT2],
    ];
    for (const [x, y] of points) {
      expect(png.pixelAt(Math.round(x), Math.round(y)), `(${x}, ${y})`).toBe(bg);
    }
  });

  it("preloads the webfont of every skin whose UI text uses one", () => {
    const bundled = new Map(
      [...css.matchAll(/@font-face \{\s*font-family: "([^"]+)";\s*src: url\("\/fonts\/([^"]+)-Variable\.woff2"\)/g)].map((m) => [m[1], m[2]]),
    );
    const expected: Record<string, string> = {};
    for (const [, selectors, family] of css.matchAll(/((?:\[data-skin="[\w-]+"\],\s*)*\[data-skin="[\w-]+"\]) \{[^}]*?--font-sans: "([^"]+)"/g)) {
      const file = bundled.get(family);
      if (!file) continue;
      for (const [, skin] of selectors.matchAll(/\[data-skin="([\w-]+)"\]/g)) expected[skin] = file;
    }
    const preloads = JSON.parse(`{${html.match(/var font = \{([^}]*)\}/)![1].replace(/(\w+):/g, '"$1":')}}`);
    expect(preloads).toEqual(expected);
    for (const file of Object.values(preloads)) expect(existsSync(join(root, `public/fonts/${file}-Variable.woff2`))).toBe(true);
  });
});
