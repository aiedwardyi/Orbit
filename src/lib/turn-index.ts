// The timeline rail's turn index for each chat: fetched on the first approach
// to the rail, kept for the session, and grown in place as turns arrive.
import { api, type Message } from "@/state/store";
import { isTurn, turnMedia, turnWords } from "../../shared/turn-index";

export interface Turns {
  ids: string[];
  /** Epoch ms. */
  at: number[];
  words: string[];
  /** Per turn: 2 an image, 1 any other file, 0 neither. */
  media: number[];
  /** The first message the chat shows, where the rail's top end lands. */
  first: string | null;
  /** Bumped on every change, so a rail knows to lay out again. */
  version: number;
  /** The active path moved away from it, so the next approach fetches it again. */
  stale: boolean;
  /** The message list last folded in: its length and newest id. */
  seen: { count: number; tail?: string };
}

interface TurnsWire {
  ids: string[];
  at: number[];
  words: string[];
  media: number[];
  first: string | null;
}

// held per chat for the session; the least recently loaded go first
const HELD = 16;
const held = new Map<string, Turns>();
const loads = new Map<string, Promise<Turns>>();

export function decodeTurns(wire: TurnsWire): Turns {
  let seconds = 0;
  return {
    ids: wire.ids,
    at: wire.at.map((gap) => (seconds += gap) * 1000),
    words: wire.words,
    media: wire.media,
    first: wire.first,
    version: 0,
    stale: false,
    seen: { count: 0 },
  };
}

/** The chat's index if this session holds a current one. */
export function heldTurns(threadId: string): Turns | null {
  const turns = held.get(threadId);
  return turns && !turns.stale ? turns : null;
}

/** One request per chat, shared by every caller while it is in flight. */
export function loadTurns(threadId: string): Promise<Turns> {
  const current = heldTurns(threadId);
  if (current) return Promise.resolve(current);
  let load = loads.get(threadId);
  if (!load) {
    load = api(`/api/threads/${threadId}/turns`)
      .then((wire: TurnsWire) => {
        const turns = decodeTurns(wire);
        held.delete(threadId);
        held.set(threadId, turns);
        if (held.size > HELD) held.delete(held.keys().next().value!);
        return turns;
      })
      .finally(() => loads.delete(threadId));
    loads.set(threadId, load);
  }
  return load;
}

export function forgetTurns(): void {
  held.clear();
  loads.clear();
}

/** Folds turns the live list gained since the index loaded; true when it grew.
 * A list that no longer leads on from the index marks it stale instead. */
export function catchUpTurns(turns: Turns, messages: readonly Message[]): boolean {
  const { count, tail } = turns.seen;
  const end = messages.at(-1);
  if (messages.length === count && end?.id === tail) return false;
  let from = count;
  if (!count || messages[count - 1]?.id !== tail) {
    const last = turns.ids.at(-1);
    const lastAt = turns.at.at(-1) ?? 0;
    const known = last ? messages.findLastIndex((message) => message.id === last) : -1;
    if (known >= 0) from = known + 1;
    // every loaded row is newer than the index: an older page holds its last turn
    else if (!last || (messages[0]?.at ?? 0) >= lastAt + 1000) from = 0;
    // the server answered with a turn this list has not received yet; a caught-up index only grows from the list
    else if (!end || (!count && end.at < lastAt + 1000 && newestTurnKnown(turns, messages))) return false;
    else {
      turns.stale = true;
      return false;
    }
  }
  turns.seen = { count: messages.length, tail: end?.id };
  let grew = false;
  for (let i = from; i < messages.length; i++) {
    const message = messages[i]!;
    if (!isTurn(message) || message.placeholder) continue;
    turns.ids.push(message.id);
    turns.at.push(message.at);
    turns.words.push(turnWords(message.text ?? ""));
    turns.media.push(turnMedia(message.text ?? ""));
    grew = true;
  }
  if (grew) turns.version++;
  return grew;
}

function newestTurnKnown(turns: Turns, messages: readonly Message[]): boolean {
  const newest = messages.findLast((message) => isTurn(message) && !message.placeholder);
  return !newest || turns.ids.includes(newest.id);
}
