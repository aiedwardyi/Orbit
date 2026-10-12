import { stripVTControlCharacters } from "node:util";
import { z } from "zod";

import { buildToolDetail } from "../shared/tool-detail.ts";
import { loadConfig } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

interface ToolCapture {
  name: string;
  input?: string;
  rawInput?: unknown;
  paths?: string[];
  command?: string;
  output?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  patches?: string[];
  grouped?: boolean;
  isError?: boolean;
}

const inputSchema = z.object({ command: z.string().optional().catch(undefined), path: z.string().optional().catch(undefined) });
const SECRET_COMMAND = /token|secret|password|passwd|credential|api[\s_-]*key|(?:^|[\s;/\\|&()'"])(?:env|printenv|set)(?=$|[\s;|&()'"])|\b(?:cat|type|get-content)\b[^\r\n;&|]*\.env/i;
const CREDENTIAL_ASSIGNMENT = /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_-]+[_-])?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|SESSION)["']?\s*[=:]\s*/gi;
const CREDENTIAL_HEADER = /(\b(?:Cookie|Set-Cookie|(?:Proxy-)?Authorization)\s*:\s*)(.*)$/i;
const MASKED_VALUE = /^«redacted \d+ chars»/;
const normalize = (text: string) => stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "");
const mask = (text: string) => /^«redacted \d+ chars»$/.test(text) ? text : `«redacted ${text.length} chars»`;

function sensitivePath(path: string): boolean {
  const normalized = normalize(path).replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (/(^|\/)\.(?:ssh|gnupg)(\/|$)/i.test(normalized)) return true;
  const name = normalized.split("/").at(-1) ?? "";
  return /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.env(?:\.|$)|^\.(?:netrc|pgpass|npmrc|pypirc)$|^credentials|secret/i.test(name);
}

function redactPreview(text: string): string {
  const safe = normalize(text).split("\n").map((line) => {
    if (/^[+-]?[A-Za-z0-9+/=]{40,}$/.test(line) && /[A-Z]/.test(line) && /[a-z]/.test(line) && /\d/.test(line) && !/^[+-]?[a-f0-9]+$/i.test(line)) {
      return /^[+-]/.test(line) ? line[0] + mask(line.slice(1)) : mask(line);
    }
    line = line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi, (_match, scheme: string, userinfo: string) => `${scheme}${mask(userinfo)}@`);
    const header = CREDENTIAL_HEADER.exec(line);
    if (header) return header[2].trim() ? line.slice(0, header.index) + header[1] + mask(header[2]) : mask(line);
    let out = "";
    let cursor = 0;
    for (const assignment of line.matchAll(CREDENTIAL_ASSIGNMENT)) {
      if (assignment.index < cursor) continue;
      const start = assignment.index + assignment[0].length;
      const rest = line.slice(start);
      const quoted = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(rest)?.[0];
      const value = quoted ?? MASKED_VALUE.exec(rest)?.[0] ?? /^[^\s"',;]+/.exec(rest)?.[0];
      if (!value) return mask(line);
      const tail = rest.slice(value.length);
      if (quoted ? tail && !/^[\s,;}\]]/.test(tail) : /\S/.test(tail) && !/^[,;}\]]/.test(tail) && !/^\s+\S+["']?\s*[=:]/.test(tail)) return mask(line);
      out += line.slice(cursor, start) + (quoted ? value[0] + mask(value.slice(1, -1)) + value.at(-1) : mask(value));
      cursor = start + value.length;
    }
    return out + line.slice(cursor);
  }).join("\n");
  return redactSecretsInText(safe);
}

export function redactToolMessage<T extends Pick<Message, "tool">>(message: T): T {
  const source = message.tool?.detail;
  if (!source) return message;
  const input = normalize(source.input ?? "");
  const detail = buildToolDetail({
    ...source,
    output: source.output?.join("\n"),
    outputHidden: source.outputHidden || SECRET_COMMAND.test(input) || input.split(/,\s*/).some(sensitivePath),
  }, redactPreview);
  return { ...message, tool: { ...message.tool, detail } };
}

function editDiff(oldText: string, newText: string): string[] {
  // Redact whole edits before removing unchanged context, including PEM delimiters.
  const lines = (text: string) => text ? redactPreview(text).replace(/\n$/, "").split("\n") : [];
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
  for (const line of redactPreview(patch).split("\n")) {
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
  const paths = source.paths ?? (args?.path ? [args.path] : []);
  const detail: Parameters<typeof buildToolDetail>[0] = {
    input: source.input ?? command ?? args?.path ?? (paths.length ? paths.join(", ") : JSON.stringify(source.rawInput ?? source.name)),
    isError: source.isError,
    outputHidden: paths.some(sensitivePath) || (source.input?.split(/,\s*/).some(sensitivePath) ?? false) || (command !== undefined && SECRET_COMMAND.test(normalize(command))),
  };
  if (!detail.outputHidden) {
    if (!source.grouped || source.isError) detail.output = source.output;
    if (!source.isError) {
      const diff = [...(source.edits ?? []).flatMap((edit) => editDiff(edit.oldText, edit.newText)), ...(source.patches ?? []).flatMap(patchDiff)];
      if (diff.length) detail.diff = diff;
    }
  }
  return buildToolDetail(detail, redactPreview);
}
