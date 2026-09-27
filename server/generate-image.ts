import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { AVATAR_IMAGE_TIMEOUT_MS, requestOpenAiImage } from "./avatar-image.ts";

export const MISSING_IMAGE_KEY =
  "No image key saved. Call request_credential with openaiImageApiKey, end the turn, then retry generate_image.";

export const generateImageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  filename: z.string().optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
});

export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function generatedImageName(requested: string | undefined): string {
  const stem = (requested ?? "")
    .replace(/\.png$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || "image"}-${randomBytes(4).toString("hex")}.png`;
}

/** First usable root's output folder; a junction or symlink out of the root is refused. */
export function generatedImagesDir(roots: readonly string[], folder = "generated-images"): string {
  for (const root of roots) {
    if (/^[\\/]{2}/.test(root)) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const dir = join(realRoot, folder);
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    const fromRoot = relative(realRoot, realDir);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw fail(403, `${folder} must stay inside your working folder`);
    }
    return realDir;
  }
  throw fail(409, "no working folder to save the file in");
}

/** One short line with the key and anything key-shaped redacted. */
export function imageErrorLine(error: unknown, apiKey: string): string {
  const { message, upstreamStatus } = error as { message?: unknown; upstreamStatus?: unknown };
  let text = String(message ?? "image generation failed");
  if (apiKey) text = text.split(apiKey).join("[key]");
  text = text.replace(/sk-[\w*.-]+/g, "[key]").replace(/\s+/g, " ").trim();
  return `${typeof upstreamStatus === "number" ? `OpenAI HTTP ${upstreamStatus}: ` : ""}${text}`.slice(0, 200);
}

export async function generateImageFile(
  apiKey: string,
  request: GenerateImageRequest,
  roots: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = AVATAR_IMAGE_TIMEOUT_MS,
): Promise<{ path: string; bytes: Buffer }> {
  const key = apiKey.trim();
  if (!key) throw fail(409, MISSING_IMAGE_KEY);
  const dir = generatedImagesDir(roots);
  let bytes: Buffer;
  try {
    bytes = await requestOpenAiImage(
      key,
      { prompt: request.prompt, size: request.size, quality: request.quality, output_format: "png" },
      "Image",
      fetchImpl,
      timeoutMs,
    );
  } catch (error) {
    throw fail(502, imageErrorLine(error, key));
  }
  const path = join(dir, generatedImageName(request.filename));
  writeFileSync(path, bytes, { flag: "wx" });
  return { path, bytes };
}
