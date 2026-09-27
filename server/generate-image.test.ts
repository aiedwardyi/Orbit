import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generatedImageName, generateImageFile, generateImageRequestSchema, imageErrorLine, MISSING_IMAGE_KEY } from "./generate-image.ts";

const KEY = "sk-proj-secretKEY123";
const REQUEST = generateImageRequestSchema.parse({ prompt: "a teal fox logo" });
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-generate-image-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pngFetch = (bytes = Buffer.from("png-bytes")) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), { status: 200 }));

describe("generate_image", () => {
  it("defaults to a medium square PNG saved under generated-images", async () => {
    const fetchMock = pngFetch();
    const result = await generateImageFile(KEY, { ...REQUEST, filename: "Hero Banner.png" }, [root], fetchMock);

    expect(dirname(result.path)).toBe(join(root, "generated-images"));
    expect(result.path).toMatch(/Hero-Banner-[0-9a-f]{8}\.png$/);
    expect(readFileSync(result.path, "utf8")).toBe("png-bytes");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({ model: "gpt-image-2", prompt: "a teal fox logo", size: "1024x1024", quality: "medium", output_format: "png" });
  });

  it("rejects unsupported sizes and qualities", () => {
    expect(generateImageRequestSchema.safeParse({ prompt: "x", size: "512x512" }).success).toBe(false);
    expect(generateImageRequestSchema.safeParse({ prompt: "x", quality: "ultra" }).success).toBe(false);
    expect(generateImageRequestSchema.safeParse({ prompt: " " }).success).toBe(false);
  });

  it("asks for the key without calling OpenAI when none is saved", async () => {
    const fetchMock = pngFetch();
    await expect(generateImageFile(" ", REQUEST, [root], fetchMock)).rejects.toMatchObject({
      message: MISSING_IMAGE_KEY,
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps traversal filenames inside generated-images", async () => {
    const result = await generateImageFile(KEY, { ...REQUEST, filename: "..\\..\\evil/../x" }, [root], pngFetch());
    expect(relative(join(root, "generated-images"), result.path)).not.toMatch(/[\\/]|^\.\./);
    expect(generatedImageName(undefined)).toMatch(/^image-[0-9a-f]{8}\.png$/);
  });

  it("refuses a generated-images junction that leaves the root", async () => {
    const outside = join(root, "outside");
    const project = join(root, "project");
    mkdirSync(outside);
    mkdirSync(project);
    symlinkSync(outside, join(project, "generated-images"), "junction");
    const fetchMock = pngFetch();

    await expect(generateImageFile(KEY, REQUEST, [project], fetchMock)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("skips missing roots and fails clearly when none exist", async () => {
    const result = await generateImageFile(KEY, REQUEST, [join(root, "gone"), root], pngFetch());
    expect(result.path.startsWith(join(root, "generated-images"))).toBe(true);
    await expect(generateImageFile(KEY, REQUEST, [join(root, "gone")], pngFetch())).rejects.toMatchObject({ status: 409 });
  });

  it("returns one short OpenAI error line with the key redacted", async () => {
    const leaky = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: `Incorrect API key provided: ${KEY}. ${"x".repeat(400)}` },
    }), { status: 401 }));

    const error = await generateImageFile(KEY, REQUEST, [root], leaky).catch((e: Error) => e);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toMatch(/^OpenAI HTTP 401: Incorrect API key provided: \[key\]/);
    expect((error as Error).message.length).toBeLessThanOrEqual(200);
    expect((error as Error).message).not.toContain("secretKEY");
    expect(imageErrorLine(new Error("bad sk-abc***xyz"), "")).toBe("bad [key]");
  });
});
