// When a bot has no folder pin, figure the project from chat: a path the
// user typed, or a name that uniquely matches a recent / scouted folder.
// An explicit pin still wins. Rooms keep their own shared-pin rules.
import { basename } from "node:path";

import { validateBotCwd } from "./bot-cwd.ts";
import { scoutProject } from "./project-scout.ts";
import { WORKSPACES_DIR } from "./workspace.ts";

export type ProjectFolderSource = "pin" | "named" | "remembered";

export type ProjectFolderResolution = {
  cwd: string | null;
  source: ProjectFolderSource | null;
};

export type ProjectFolderInput = {
  pin?: string | null;
  remembered?: string | null;
  userTexts?: string[];
  recentPaths?: string[];
  scoutName?: (cwd: string) => string | null;
  isPrivateWorkspace?: (cwd: string) => boolean;
};

const PATH_IN_TEXT =
  /(?:^|[\s"'`])((?:~(?:\/[^\s"'`]*)?|\/[^\s"'`]+|[a-zA-Z]:[\\/][^\s"'`]+|file:\/\/[^\s)"']+))/gi;
const QUOTED = /"([^"\n]{1,200})"|'([^'\n]{1,200})'/g;

function existingFolder(input: string): string | null {
  const checked = validateBotCwd(input);
  return checked.ok ? checked.cwd : null;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,);:\]]+$/g, "");
}

function defaultScoutName(cwd: string): string | null {
  try {
    const name = scoutProject(cwd).name.trim();
    return name || null;
  } catch {
    return null;
  }
}

function defaultPrivateWorkspace(cwd: string): boolean {
  const folder = existingFolder(cwd);
  const root = existingFolder(WORKSPACES_DIR);
  if (!folder || !root) return cwd === WORKSPACES_DIR || cwd.startsWith(`${WORKSPACES_DIR}/`);
  return folder === root || folder.startsWith(`${root}/`);
}

function mentionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}._-])${escaped}(?![\\p{L}\\p{N}._-])`, "iu");
}

function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return mentionPattern(trimmed).test(text);
}

function extractPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    let raw = stripTrailingPunctuation(match[1] ?? "");
    if (raw.toLowerCase().startsWith("file://")) {
      try {
        raw = decodeURIComponent(new URL(raw).pathname);
      } catch {
        continue;
      }
    }
    const folder = existingFolder(raw);
    if (folder) found.push(folder);
  }
  return found;
}

function extractQuotedNames(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value) found.push(value);
  }
  return found;
}

function uniqueNamedFolder(
  name: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
): string | null {
  const needle = name.trim();
  if (!needle) return null;
  const matches = candidates.filter((cwd) => {
    if (basename(cwd).localeCompare(needle, undefined, { sensitivity: "accent" }) === 0) return true;
    const scouted = scoutName(cwd);
    return Boolean(scouted && scouted.localeCompare(needle, undefined, { sensitivity: "accent" }) === 0);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function namedFolderInText(
  text: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
): string | null {
  const quoted = extractQuotedNames(text);
  for (let i = quoted.length - 1; i >= 0; i--) {
    const value = quoted[i]!;
    const asPath = existingFolder(value);
    if (asPath) return asPath;
    const named = uniqueNamedFolder(value, candidates, scoutName);
    if (named) return named;
  }

  const mentioned = candidates.filter((cwd) => {
    if (mentionsName(text, basename(cwd))) return true;
    const scouted = scoutName(cwd);
    return Boolean(scouted && mentionsName(text, scouted));
  });
  const unique = [...new Set(mentioned)];
  return unique.length === 1 ? unique[0]! : null;
}

function usableFolder(
  cwd: string | null | undefined,
  isPrivateWorkspace: (cwd: string) => boolean,
): string | null {
  if (!cwd) return null;
  const folder = existingFolder(cwd);
  if (!folder || isPrivateWorkspace(folder)) return null;
  return folder;
}

/** Unique existing project folders the resolver may match a name against. */
export function projectPathsFromRecords(input: {
  bots: Array<{
    cwd?: string;
    lastProjectCwd?: string;
    tasks?: Array<{ cwd?: string | null }>;
  }>;
  groups?: Array<{ cwd?: string }>;
}): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (cwd?: string | null) => {
    if (!cwd || seen.has(cwd)) return;
    seen.add(cwd);
    paths.push(cwd);
  };
  for (const bot of input.bots) {
    add(bot.cwd);
    add(bot.lastProjectCwd);
    for (const task of bot.tasks ?? []) add(task.cwd);
  }
  for (const group of input.groups ?? []) add(group.cwd);
  return paths;
}

/** User chat lines that may name a folder, oldest first, plus the current send. */
export function userProjectTexts(
  messages: Array<{ role?: string; kind?: string; text?: string }>,
  currentText?: string,
): string[] {
  const texts = messages.flatMap((message) =>
    message.role === "user" && message.kind === "text" && message.text?.trim()
      ? [message.text]
      : [],
  );
  const current = currentText?.trim();
  if (current && texts.at(-1) !== current) texts.push(current);
  return texts;
}

export function resolveProjectFolder(input: ProjectFolderInput): ProjectFolderResolution {
  const scoutName = input.scoutName ?? defaultScoutName;
  const isPrivateWorkspace = input.isPrivateWorkspace ?? defaultPrivateWorkspace;
  if (input.pin?.trim()) return { cwd: input.pin, source: "pin" };

  const userTexts = input.userTexts ?? [];
  const candidates = [
    ...new Set(
      [...(input.recentPaths ?? []), ...userTexts.flatMap(extractPaths)]
        .map((cwd) => usableFolder(cwd, isPrivateWorkspace))
        .filter((cwd): cwd is string => Boolean(cwd)),
    ),
  ];

  for (const text of [...userTexts].reverse()) {
    const paths = extractPaths(text);
    const lastPath = paths.at(-1);
    if (lastPath && !isPrivateWorkspace(lastPath)) return { cwd: lastPath, source: "named" };
    const named = namedFolderInText(text, candidates, scoutName);
    if (named) return { cwd: named, source: "named" };
  }

  const remembered = usableFolder(input.remembered, isPrivateWorkspace);
  if (remembered) return { cwd: remembered, source: "remembered" };
  return { cwd: null, source: null };
}

/** Resolve, remember a newly named project, and return the folder to pin. */
export function applyResolvedProjectFolder(input: ProjectFolderInput & {
  remember: (cwd: string) => void;
}): string | undefined {
  const resolved = resolveProjectFolder(input);
  if (resolved.source === "named" && resolved.cwd) input.remember(resolved.cwd);
  return resolved.cwd ?? undefined;
}
