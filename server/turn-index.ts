// The timeline rail's index of one chat: every turn on the active path,
// columnar so a long thread stays near 100 bytes a turn on the wire.
import { isTurn, turnMedia, turnWords } from "../shared/turn-index.ts";

import type { Message } from "./store.ts";

export interface TurnIndex {
  ids: string[];
  /** Seconds: the first turn's epoch time, then the gap since the turn before. */
  at: number[];
  words: string[];
  /** Per turn: 2 an image, 1 any other file, 0 neither. */
  media: number[];
  /** The first row the chat draws as a message, where the rail's top end lands. */
  first: string | null;
}

export function turnIndex(path: readonly Message[]): TurnIndex {
  const index: TurnIndex = { ids: [], at: [], words: [], media: [], first: null };
  let previous = 0;
  for (const message of path) {
    if (index.first === null && message.kind === "text" && !(message.role === "bot" && message.summarized)) index.first = message.id;
    if (!isTurn(message)) continue;
    const at = Math.floor(message.at / 1000);
    index.ids.push(message.id);
    index.at.push(at - previous);
    index.words.push(turnWords(message.text ?? ""));
    index.media.push(turnMedia(message.text ?? ""));
    previous = at;
  }
  return index;
}
