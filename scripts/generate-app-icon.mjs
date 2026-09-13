// Regenerates every raster app-icon surface from the 1024 master.
//
//   node scripts/generate-app-icon.mjs --source <path-to-1024-master>
//   node scripts/generate-app-icon.mjs --check
//
// The master has an alpha channel but everything outside the rounded square
// is OPAQUE WHITE, so it cannot ship as-is: the white corners are
// flood-filled to transparent from the borders (with the anti-aliased edge
// unblended from white), then every shipped size is area-averaged down from
// the cleaned 1024 with premultiplied alpha. ICO/ICNS containers are rebuilt
// from those same renders. No image dependencies — pure node:zlib PNG codec.
// --source is required: the master is author-provided and lives outside the
// repo, so there is no in-repo default.
//
// --check is read-only: it re-reads every shipped PNG and fails if any
// corner is not fully transparent (also wired into
// scripts/app-icon-assets.test.mjs). It never writes and never needs --source.
import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Slate base of the new artwork; the outer edge is always a blend of this
// with white, which is what lets the fringe unblend back to a clean edge.
const EDGE_FG = [55, 65, 80];

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
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
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
        value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255;
      }
      row[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      pixels[o] = row[x * channels];
      pixels[o + 1] = channels >= 3 ? row[x * channels + 1] : row[x * channels];
      pixels[o + 2] = channels >= 3 ? row[x * channels + 2] : row[x * channels];
      pixels[o + 3] = channels === 4 ? row[x * channels + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

/** Masks the opaque-white surround to alpha 0, keeping an anti-aliased edge. */
function cleanWhite({ width, height, pixels }) {
  const isWhite = (i) =>
    pixels[i] >= 244 && pixels[i + 1] >= 244 && pixels[i + 2] >= 244 && pixels[i + 3] > 0;
  const background = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) {
    stack.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + width - 1);
  }
  while (stack.length) {
    const p = stack.pop();
    if (background[p]) continue;
    const i = p * 4;
    if (!isWhite(i)) continue;
    background[p] = 1;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - width);
    if (y < height - 1) stack.push(p + width);
  }
  const out = Buffer.from(pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (background[p]) {
        out[i + 3] = 0;
        continue;
      }
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (background[ny * width + nx]) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) continue;
      // Observed = t * fg + (1 - t) * white: recover t per channel against
      // the slate base, unblend, and keep the original colour when opaque.
      const t = Math.max(
        (255 - out[i]) / (255 - EDGE_FG[0]),
        (255 - out[i + 1]) / (255 - EDGE_FG[1]),
        (255 - out[i + 2]) / (255 - EDGE_FG[2]),
        0,
      );
      if (t >= 1) continue;
      if (t <= 0) {
        out[i + 3] = 0;
        continue;
      }
      out[i] = Math.min(255, Math.max(0, Math.round((out[i] - (1 - t) * 255) / t)));
      out[i + 1] = Math.min(255, Math.max(0, Math.round((out[i + 1] - (1 - t) * 255) / t)));
      out[i + 2] = Math.min(255, Math.max(0, Math.round((out[i + 2] - (1 - t) * 255) / t)));
      out[i + 3] = Math.round(t * 255);
    }
  }
  return { width, height, pixels: out };
}

/** Area-average downscale with premultiplied alpha. */
function resample(src, dstWidth, dstHeight) {
  const dst = Buffer.alloc(dstWidth * dstHeight * 4);
  const scaleX = src.width / dstWidth;
  const scaleY = src.height / dstHeight;
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      const y0 = y * scaleY;
      const y1 = (y + 1) * scaleY;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const w = wx * wy;
          const i = (Math.min(sy, src.height - 1) * src.width + Math.min(sx, src.width - 1)) * 4;
          const alpha = src.pixels[i + 3] / 255;
          r += src.pixels[i] * alpha * w;
          g += src.pixels[i + 1] * alpha * w;
          b += src.pixels[i + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (y * dstWidth + x) * 4;
      if (a > 0) {
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
        dst[o + 3] = Math.round((a / weight) * 255);
      }
    }
  }
  return { width: dstWidth, height: dstHeight, pixels: dst };
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      candidates[0][x] = row[x];
      candidates[1][x] = (row[x] - left) & 255;
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upperLeft);
      candidates[2][x] = (row[x] - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 3; f++) {
      // Standard minimum-sum-of-absolute-values heuristic: each filtered
      // byte is a signed residual, so its magnitude is v (v <= 127) or
      // 256 - v. |v - 128| and plain |v| both mis-score small negatives.
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = candidates[f][x];
        score += v <= 127 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    // candidate index maps to PNG filter 0 (none), 1 (sub), 4 (paeth)
    const filter = best === 0 ? 0 : best === 1 ? 1 : 4;
    raw[y * (stride + 1)] = filter;
    candidates[best].copy(raw, y * (stride + 1) + 1);
    previous = row;
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Vista-style ICO: PNG payloads, same six sizes the project already ships. */
function encodeIco(rendered) {
  const sizes = [256, 128, 64, 48, 32, 16];
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  const bodies = sizes.map((size, index) => {
    const body = encodePng(rendered[size]);
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(body.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += body.length;
    return body;
  });
  return Buffer.concat([header, ...bodies]);
}

/** ICNS with PNG entries mirroring the project's current type set. */
function encodeIcns(rendered) {
  const entries = [];
  const put = (type, size) => {
    const body = encodePng(rendered[size]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(8 + body.length);
    entries.push(Buffer.concat([Buffer.from(type, "ascii"), length, body]));
  };
  put("ic10", 1024);
  put("ic09", 512);
  put("ic14", 512);
  put("ic08", 256);
  put("ic13", 256);
  put("ic07", 128);
  put("ic12", 64);
  put("ic11", 32);
  // Carry the existing 'info' block so the container keeps its shape.
  try {
    const current = readFileSync(join(ROOT, "build/icon.icns"));
    let offset = 8;
    while (offset + 8 <= current.length) {
      const type = current.toString("ascii", offset, offset + 4);
      const length = current.readUInt32BE(offset + 4);
      if (type === "info") {
        entries.push(current.subarray(offset, offset + length));
        break;
      }
      offset += length;
    }
  } catch {
    // First generation without a previous container: PNG entries stand alone.
  }
  const total = Buffer.alloc(4);
  total.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0));
  return Buffer.concat([Buffer.from("icns", "ascii"), total, ...entries]);
}

const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_64x64.png", 64],
  ["icon_64x64@2x.png", 128],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const SHIPPED_PNGS = [
  "build/icon-1024.png",
  ...ICONSET.map(([name]) => `build/icon.iconset/${name}`),
  "electron/resources/app-icon.png",
];

/** Read-only validation of the shipped PNGs: no writes, no source needed. */
function check() {
  let failed = 0;
  for (const relative of SHIPPED_PNGS) {
    const image = decodePng(join(ROOT, relative));
    // decodePng always expands to RGBA.
    const alpha = (x, y) => image.pixels[(y * image.width + x) * 4 + 3];
    const corners = [
      alpha(0, 0),
      alpha(image.width - 1, 0),
      alpha(0, image.height - 1),
      alpha(image.width - 1, image.height - 1),
    ];
    const center = alpha(image.width >> 1, image.height >> 1);
    const ok = corners.every((a) => a === 0) && center === 255;
    if (!ok) failed++;
    console.log(`${ok ? "ok" : "FAIL"} ${relative} corners[${corners.join(",")}] centerA=${center}`);
  }
  if (failed) {
    console.error(`${failed} file(s) failed the corner-transparency check`);
    process.exitCode = 1;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) return check();
  const sourceIndex = args.indexOf("--source");
  if (sourceIndex === -1 || !args[sourceIndex + 1]) {
    console.error("missing required --source <path-to-1024-master>");
    process.exitCode = 1;
    return;
  }
  const source = args[sourceIndex + 1];
  const master = cleanWhite(decodePng(source));
  const rendered = {};
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    rendered[size] = size === 1024 ? master : resample(master, size, size);
  }
  const write = (relative, data) => {
    const path = join(ROOT, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    console.log(`wrote ${relative}`);
  };
  write("build/icon-1024.png", encodePng(rendered[1024]));
  for (const [name, size] of ICONSET) write(`build/icon.iconset/${name}`, encodePng(rendered[size]));
  write("electron/resources/app-icon.png", encodePng(rendered[256]));
  write("build/icon.ico", encodeIco(rendered));
  write("build/icon.icns", encodeIcns(rendered));
}

main();
