import { z } from "zod";

import { buildToolDetail } from "../shared/tool-detail.ts";
import { loadConfig } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";

interface ToolCapture {
  name: string;
  input?: string;
  rawInput?: unknown;
  command?: string;
  output?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  patches?: string[];
  grouped?: boolean;
  isError?: boolean;
}

const inputSchema = z.object({ command: z.string().optional().catch(undefined), path: z.string().optional().catch(undefined) });
const SECRET_COMMAND = /token|secret|password|passwd|credential|api[\s_-]*key|(?:^|[\s;/\\|&()'"])(?:env|printenv|set)(?=$|[\s;|&()'"])|\b(?:cat|type|get-content)\b[^\r\n;&|]*\.env/i;

function editDiff(oldText: string, newText: string): string[] {
  // Redact whole edits before removing unchanged context, including PEM delimiters.
  const lines = (text: string) => text ? redactSecretsInText(text).replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n") : [];
  const before = lines(oldText);
  const after = lines(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const positions = new Map<string, number[]>();
  for (let i = start; i < newEnd; i++) {
    const indices = positions.get(after[i]) ?? [];
    indices.push(i);
    positions.set(after[i], indices);
  }
  const cursors = new Map<string, number>();
  const diff: string[] = [];
  let next = start;
  for (let i = start; i < oldEnd; i++) {
    const indices = positions.get(before[i]) ?? [];
    let cursor = cursors.get(before[i]) ?? 0;
    while (cursor < indices.length && indices[cursor] < next) cursor++;
    cursors.set(before[i], cursor);
    const match = indices[cursor];
    if (match === undefined) diff.push(`-${before[i]}`);
    else {
      for (; next < match; next++) diff.push(`+${after[next]}`);
      next = match + 1;
    }
  }
  for (; next < newEnd; next++) diff.push(`+${after[next]}`);
  return diff;
}

function patchDiff(patch: string): string[] {
  const diff: string[] = [];
  let inHunk = false;
  for (const line of redactSecretsInText(patch).replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && /^[+-]/.test(line)) diff.push(line);
  }
  return diff;
}

export function captureToolDetail(source: ToolCapture) {
  if (loadConfig().features?.toolDetailCapture !== true) return undefined;
  const parsed = inputSchema.safeParse(source.rawInput);
  const args = parsed.success ? parsed.data : undefined;
  const command = source.command ?? args?.command;
  const detail: Parameters<typeof buildToolDetail>[0] = {
    input: source.input ?? command ?? args?.path ?? JSON.stringify(source.rawInput ?? source.name),
    isError: source.isError,
    outputHidden: command !== undefined && SECRET_COMMAND.test(command),
  };
  if (!detail.outputHidden) {
    if (!source.grouped || source.isError) detail.output = source.output;
    if (!source.isError) {
      const diff = [...(source.edits ?? []).flatMap((edit) => editDiff(edit.oldText, edit.newText)), ...(source.patches ?? []).flatMap(patchDiff)];
      if (diff.length) detail.diff = diff;
    }
  }
  return buildToolDetail(detail, redactSecretsInText);
}
