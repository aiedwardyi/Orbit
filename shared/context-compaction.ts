import { z } from "zod";

export const CONTEXT_COMPACTION_VERSION = 1 as const;

const idSchema = z.string().min(1).max(200);
const versionEnvelopeSchema = z.object({ v: z.number().int().positive() }).passthrough();
const contextCompactionV1Schema = z.object({
  v: z.literal(CONTEXT_COMPACTION_VERSION),
  summary: z.string().trim().min(1).max(32_000),
  coveredThroughId: idSchema,
  firstKeptId: idSchema.nullable(),
  previousCompactionId: idSchema.optional(),
  contextWindow: z.number().int().positive(),
  estimatedTokensBefore: z.number().int().positive(),
  sourceMessageCount: z.number().int().nonnegative(),
}).strict();

export type ContextCompactionV1 = z.infer<typeof contextCompactionV1Schema>;

export type ContextCompactionRead =
  | { status: "valid"; value: ContextCompactionV1 }
  | { status: "unsupported"; version: number }
  | { status: "invalid" };

export interface ContextCompactionInput {
  value: unknown;
}

export function readContextCompaction(input: ContextCompactionInput): ContextCompactionRead {
  const version = versionEnvelopeSchema.safeParse(input.value);
  if (!version.success) return { status: "invalid" };
  if (version.data.v !== CONTEXT_COMPACTION_VERSION) {
    return { status: "unsupported", version: version.data.v };
  }
  const parsed = contextCompactionV1Schema.safeParse(input.value);
  return parsed.success ? { status: "valid", value: parsed.data } : { status: "invalid" };
}
