// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, extensionForMime, importLocalImage, readAttachment, saveImage, sniffImageMime } = await import("./attachments.ts");

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

describe("sniffImageMime", () => {
  it("reads the format from magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF....WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses text and svg", () => {
    expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("importLocalImage", () => {
  const src = join(DATA_ROOT, "src");
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it("copies a real PNG into the store under a generated name", () => {
    const file = join(src, "mockup.png");
    writeFileSync(file, PNG);
    const saved = importLocalImage(file);
    expect(saved.mime).toBe("image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.name).not.toContain("mockup");
    expect(readAttachment(saved.name)?.bytes.equals(PNG)).toBe(true);
  });

  it("stores by sniffed format, not by extension", () => {
    const file = join(src, "shot.jpg");
    writeFileSync(file, PNG);
    expect(importLocalImage(file).name.endsWith(".png")).toBe(true);
  });

  it("rejects a text file named .png", () => {
    const file = join(src, "fake.png");
    writeFileSync(file, "hello");
    expect(() => importLocalImage(file)).toThrow(/not a PNG, JPEG, GIF, or WebP/);
  });

  it("rejects missing, relative, directory, empty, and oversized paths", () => {
    expect(() => importLocalImage(join(src, "nope.png"))).toThrow(/file not found/);
    expect(() => importLocalImage("mockup.png")).toThrow(/absolute/);
    expect(() => importLocalImage(src)).toThrow(/regular file/);
    const empty = join(src, "empty.png");
    writeFileSync(empty, "");
    expect(() => importLocalImage(empty)).toThrow(/empty/);
    const big = join(src, "big.png");
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
    expect(() => importLocalImage(big)).toThrow(/exceeds/);
  });
});

describe("show-image route", () => {
  const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  const route = indexSource.slice(indexSource.indexOf('path === "/api/internal/show-image"'));

  it("publishes into the sender's own thread as a screen message", () => {
    expect(route).toContain("connectorThread(from.id, fromThreadId)");
    expect(route).toContain("importLocalImage(");
    expect(route).toContain('kind: "screen"');
    expect(route).toContain("url: `/api/attachments/${saved.name}`");
  });

  it("tells bots about show_image only when the agents integration is mounted", () => {
    expect(indexSource).toContain('const showImagePrompt = integrations.agents ? ` ${SHOW_IMAGE_GUIDANCE}` : "";');
    expect(indexSource).toContain("integrations.agents && SHOW_IMAGE_GUIDANCE");
  });
});
