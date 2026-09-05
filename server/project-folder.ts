// When a bot has no folder pin, figure the project from chat: a path the
// user typed, or a name that uniquely matches a recent / scouted folder.
// Unknown names get a light home/search walk. "not X" / "don't use X"
// clears a sticky remembered folder. An explicit pin still wins. Rooms
// keep their own shared-pin rules. A folder is optional — never required.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

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
  /** Immediate-child roots to walk when a name is not among recent paths. */
  searchRoots?: string[];
  scoutName?: (cwd: string) => string | null;
  isPrivateWorkspace?: (cwd: string) => boolean;
};

const PATH_IN_TEXT =
  /(?:^|[\s"'`])((?:~(?:\/[^\s"'`]*)?|\/[^\s"'`]+|[a-zA-Z]:[\\/][^\s"'`]+|file:\/\/[^\s)"']+))/gi;
const QUOTED = /"([^"\n]{1,200})"|'([^'\n]{1,200})'/g;
const EN_NEGATION =
  /\b(?:[Nn]ot(?:\s+[Uu]sing)?|[Dd]on['’]t\s+(?:[Uu]se|[Uu]sing)|[Dd]o\s+[Nn]ot\s+(?:[Uu]se|[Uu]sing)|[Dd]on['’]t\s+(?:look\s+at|[Oo]pen|[Pp]ick|[Cc]hoose))\s+(?:(?:[Tt]he|[Aa])\s+)?(?:"([^"\n]{1,200})"|'([^'\n]{1,200})'|([^\s"'`,.;:!?]+(?:\s+[A-Z][^\s"'`,.;:!?]+)*))/g;
const KO_NEGATION =
  /(?:"([^"\n]{1,200})"|'([^'\n]{1,200})'|([^\s"'`]+?))(?:은|는|을|를)?\s*(?:말고|아니(?:야|에요|예요)?|쓰지\s*마|사용하지\s*마)/gu;
const TRAILING_KIND = /\s+(folder|project|directory|dir|workspace|폴더|프로젝트|워크스페이스)$/iu;
const SEARCH_ROOT_NAMES = [
  "Desktop",
  "Documents",
  "Downloads",
  "Projects",
  "Developer",
  "dev",
  "src",
  "code",
  "repos",
  "work",
  "github",
  "gitlab",
  "workspace",
];
const MAX_SEARCH_CHILDREN = 400;
const HOME_FOLDER_WORDS = new Set([
  ...SEARCH_ROOT_NAMES.map((name) => name.toLowerCase()),
  "pictures",
  "music",
  "movies",
  "library",
  "applications",
  "public",
  "users",
]);
const CHAT_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "it",
  "its",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "need",
  "needs",
  "please",
  "thanks",
  "thank",
  "just",
  "can",
  "could",
  "would",
  "should",
  "today",
  "folder",
  "project",
  "here",
  "there",
  "one",
  "use",
  "using",
  "open",
  "look",
  "looking",
  "not",
  "dont",
  "into",
  "about",
  "after",
  "ship",
  "fix",
  "add",
  "release",
  "note",
  "notes",
  "meant",
  "is",
  "are",
  "be",
  "do",
  "will",
  "want",
  "keep",
  "going",
  "help",
  "그리고",
  "오늘",
  "폴더",
  "프로젝트",
  "이거",
  "그거",
  "해줘",
  "말고",
]);

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

function memoScout(scoutName: (cwd: string) => string | null): (cwd: string) => string | null {
  const cache = new Map<string, string | null>();
  return (cwd) => {
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    const name = scoutName(cwd);
    cache.set(cwd, name);
    return name;
  };
}

function isContainedPath(root: string, folder: string): boolean {
  const rel = relative(root, folder);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function defaultPrivateWorkspace(cwd: string): boolean {
  const folder = existingFolder(cwd);
  const root = existingFolder(WORKSPACES_DIR);
  if (!folder || !root) return isContainedPath(WORKSPACES_DIR, cwd);
  return isContainedPath(root, folder);
}

function defaultSearchRoots(home = homedir()): string[] {
  return [home, ...SEARCH_ROOT_NAMES.map((name) => join(home, name))];
}

/** Home plus common project parents — the default light search walk. */
export function projectSearchRoots(home = homedir()): string[] {
  return defaultSearchRoots(home);
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

function nameEquals(left: string, right: string): boolean {
  return left.trim().localeCompare(right.trim(), undefined, { sensitivity: "base" }) === 0;
}

function nameExcluded(name: string, excluded: string[]): boolean {
  return excluded.some((item) => nameEquals(item, name));
}

function normalizeNegatedName(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(?:using|use|looking\s+at)\s+/iu, "")
    .replace(TRAILING_KIND, "")
    .trim();
}

function negatedProjectNames(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [EN_NEGATION, KO_NEGATION]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = normalizeNegatedName(match[1] ?? match[2] ?? match[3] ?? "");
      if (name && !nameExcluded(name, found)) found.push(name);
    }
  }
  return found;
}

function isSignificantMention(name: string, quoted: string[], homeWalk: boolean): boolean {
  if (quoted.some((item) => nameEquals(item, name))) return true;
  const trimmed = name.trim();
  if (!trimmed || CHAT_STOPWORDS.has(trimmed.toLowerCase())) return false;
  if (homeWalk && HOME_FOLDER_WORDS.has(trimmed.toLowerCase())) return false;
  return !/^[A-Za-z]{1,2}$/.test(trimmed);
}

function folderHasName(cwd: string, name: string, scoutName: (cwd: string) => string | null): boolean {
  if (nameEquals(basename(cwd), name)) return true;
  const scouted = scoutName(cwd);
  return Boolean(scouted && nameEquals(scouted, name));
}

function folderExcluded(
  cwd: string,
  excluded: string[],
  scoutName: (cwd: string) => string | null,
): boolean {
  return excluded.some((name) => {
    const asPath = existingFolder(name);
    return asPath === cwd || folderHasName(cwd, name, scoutName);
  });
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

function foldersMatchingName(
  name: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
): string[] {
  const needle = name.trim();
  if (!needle) return [];
  return candidates.filter((cwd) => folderHasName(cwd, needle, scoutName));
}

function uniqueNamedFolder(
  name: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
): string | null {
  const matches = foldersMatchingName(name, candidates, scoutName);
  return matches.length === 1 ? matches[0]! : null;
}

function namedMatchesInText(
  text: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
  excluded: string[],
  homeWalk: boolean,
): string[] {
  const quoted = extractQuotedNames(text);
  for (let i = quoted.length - 1; i >= 0; i--) {
    const value = quoted[i]!;
    if (nameExcluded(value, excluded)) continue;
    const asPath = existingFolder(value);
    if (asPath && !folderExcluded(asPath, excluded, scoutName)) return [asPath];
    const named = uniqueNamedFolder(value, candidates, scoutName);
    if (named && !folderExcluded(named, excluded, scoutName)) return [named];
  }

  const mentioned = candidates.filter((cwd) => {
    if (folderExcluded(cwd, excluded, scoutName)) return false;
    const base = basename(cwd);
    if (mentionsName(text, base) && isSignificantMention(base, quoted, homeWalk)) return true;
    const scouted = scoutName(cwd);
    return Boolean(scouted && mentionsName(text, scouted) && isSignificantMention(scouted, quoted, homeWalk));
  });
  return [...new Set(mentioned)];
}

function shouldScoutWalk(text: string): boolean {
  if (extractQuotedNames(text).length > 0) return true;
  return /(?<![\p{L}\p{N}])[\p{Lu}][\p{L}\p{N}._-]{2,}/u.test(text);
}

function shouldWalk(text: string): boolean {
  if (extractQuotedNames(text).length > 0) return true;
  const tokens = text.match(/[\p{L}\p{N}._-]+/gu) ?? [];
  return tokens.some((token) => isSignificantMention(token, [], true));
}

function namedFolderInText(
  text: string,
  candidates: string[],
  scoutName: (cwd: string) => string | null,
  excluded: string[],
  homeWalk: boolean,
): string | null {
  const matches = namedMatchesInText(text, candidates, scoutName, excluded, homeWalk);
  return matches.length === 1 ? matches[0]! : null;
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

/** Hidden names are dropped before the walk budget so a root full of
 *  dotfiles cannot crowd out real project folders. */
export function visibleSearchChildNames(entries: string[]): string[] {
  return entries.filter((name) => !name.startsWith(".")).slice(0, MAX_SEARCH_CHILDREN);
}

function listSearchChildren(root: string): string[] {
  try {
    return visibleSearchChildNames(readdirSync(root)).map((name) => join(root, name));
  } catch {
    return [];
  }
}

function searchProjectDirs(
  roots: string[],
  isPrivateWorkspace: (cwd: string) => boolean,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const folder = existingFolder(root);
    if (!folder) continue;
    for (const child of listSearchChildren(folder)) {
      const usable = usableFolder(child, isPrivateWorkspace);
      if (!usable || seen.has(usable)) continue;
      seen.add(usable);
      paths.push(usable);
    }
  }
  return paths;
}

function excludedNamesFromTexts(texts: string[]): string[] {
  const excluded: string[] = [];
  for (const text of [...texts].reverse()) {
    for (const name of negatedProjectNames(text)) {
      if (!nameExcluded(name, excluded)) excluded.push(name);
    }
  }
  return excluded;
}

function rememberedRuledOut(
  input: ProjectFolderInput,
  scoutName: (cwd: string) => string | null,
  isPrivateWorkspace: (cwd: string) => boolean,
): boolean {
  const remembered = usableFolder(input.remembered, isPrivateWorkspace);
  if (!remembered) return false;
  return folderExcluded(remembered, excludedNamesFromTexts(input.userTexts ?? []), scoutName);
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
  const scoutName = memoScout(input.scoutName ?? defaultScoutName);
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

  const excluded: string[] = [];
  let searchCache: string[] | null = null;
  const searchDirs = () => {
    searchCache ??= searchProjectDirs(input.searchRoots ?? defaultSearchRoots(), isPrivateWorkspace);
    return searchCache;
  };

  for (const text of [...userTexts].reverse()) {
    for (const name of negatedProjectNames(text)) {
      if (!nameExcluded(name, excluded)) excluded.push(name);
    }

    const paths = extractPaths(text);
    const lastPath = paths.at(-1);
    if (lastPath && !isPrivateWorkspace(lastPath) && !folderExcluded(lastPath, excluded, scoutName)) {
      return { cwd: lastPath, source: "named" };
    }

    const recentMatches = namedMatchesInText(text, candidates, scoutName, excluded, false);
    if (recentMatches.length === 1) return { cwd: recentMatches[0]!, source: "named" };
    if (recentMatches.length > 1) continue;
    if (!shouldWalk(text)) continue;

    const searchHits = searchDirs();
    const byBasename = namedMatchesInText(text, searchHits, () => null, excluded, true);
    if (byBasename.length === 1) return { cwd: byBasename[0]!, source: "named" };
    if (byBasename.length > 1) continue;
    if (!shouldScoutWalk(text)) continue;

    const named = namedFolderInText(text, searchHits, scoutName, excluded, true);
    if (named) return { cwd: named, source: "named" };
  }

  const remembered = usableFolder(input.remembered, isPrivateWorkspace);
  if (remembered && !folderExcluded(remembered, excluded, scoutName)) {
    return { cwd: remembered, source: "remembered" };
  }
  return { cwd: null, source: null };
}

/** Resolve, remember a newly named project, and return the folder to pin. */
export function applyResolvedProjectFolder(input: ProjectFolderInput & {
  remember: (cwd: string) => void;
  forget?: () => void;
}): string | undefined {
  const scoutName = memoScout(input.scoutName ?? defaultScoutName);
  const isPrivateWorkspace = input.isPrivateWorkspace ?? defaultPrivateWorkspace;
  const resolved = resolveProjectFolder({ ...input, scoutName });
  if (resolved.source === "named" && resolved.cwd) input.remember(resolved.cwd);
  else if (input.forget && rememberedRuledOut(input, scoutName, isPrivateWorkspace)) {
    input.forget();
  }
  return resolved.cwd ?? undefined;
}
