// Minimal dependency-free PNG codec for the app-icon tooling.
//
// decodePng reads 8-bit RGBA PNGs (the only combination the icon pipeline
// accepts) and always expands to RGBA pixels. Anything else — palette,
// grayscale, missing alpha, 16-bit, interlaced — is rejected with a loud
// error BEFORE any asset is written, so a wrong source can never silently
// produce garbage. Shared by scripts/generate-app-icon.mjs and its test so
// the two can never diverge on what a PNG means.
import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

export function decodePng(path) {
  const bytes = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      interlace = bytes[offset + 20];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (colorType !== 6 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `png-codec: refusing ${path}: only non-interlaced 8-bit RGBA PNGs are supported ` +
        `(got color type ${colorType}, bit depth ${bitDepth}, interlace ${interlace})`,
    );
  }
  const channels = 4;
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
    row.copy(pixels, y * stride);
    previous = row;
  }
  return { width, height, pixels };
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

function filterRow(row, previous, kind) {
  const out = Buffer.alloc(row.length);
  for (let x = 0; x < row.length; x++) {
    const left = x >= 4 ? row[x - 4] : 0;
    const up = previous[x];
    const upperLeft = x >= 4 ? previous[x - 4] : 0;
    if (kind === 0) out[x] = row[x];
    else if (kind === 1) out[x] = (row[x] - left) & 255;
    else if (kind === 2) out[x] = (row[x] - up) & 255;
    else if (kind === 3) out[x] = (row[x] - ((left + up) >> 1)) & 255;
    else {
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upperLeft);
      out[x] = (row[x] - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255;
    }
  }
  return out;
}

export function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    let bestRow = null;
    for (let kind = 0; kind <= 4; kind++) {
      const candidate = filterRow(row, previous, kind);
      // Minimum-sum-of-absolute-values: each filtered byte is a signed
      // residual, so its magnitude is v (v <= 127) or 256 - v.
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = candidate[x];
        score += v <= 127 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = kind;
        bestRow = candidate;
      }
    }
    raw[y * (stride + 1)] = best;
    bestRow.copy(raw, y * (stride + 1) + 1);
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
