import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { findHitIndex, findStops, setFindCurrent, stepFind, watchChatFindHighlight, type FindStop } from "@/lib/chat-find";
import { landOnSearchHit, restoreChatChrome } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { api, useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";

const PAGE = 100;

export function ChatFindBar({
  threadId,
  initialQuery = "",
  initialMessageId = null,
  onClose,
}: {
  threadId: string;
  initialQuery?: string;
  initialMessageId?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  // default skins draw a tool row as its name, so output must not match there
  const view = isTerminalSkin(useSkin()) ? "" : "&view=chips";
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const anchorRef = useRef(initialMessageId);
  const anchorQueryRef = useRef(initialQuery);
  const hitsQueryRef = useRef("");
  const pagingRef = useRef(false);
  const freshRef = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [more, setMore] = useState(false);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const stops = useMemo(() => findStops(hits), [hits]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      setFindCurrent(null);
      restoreChatChrome();
    };
  }, []);

  const searchPath = (text: string, before?: string) =>
    `/api/search?q=${encodeURIComponent(text)}&limit=${PAGE}&threadId=${encodeURIComponent(threadId)}${view}` +
    (before ? `&before=${encodeURIComponent(before)}` : "");

  useEffect(() => {
    const trimmed = query.trim();
    const request = ++requestRef.current;
    pagingRef.current = false;
    setFindCurrent(null);
    if (!trimmed) {
      hitsQueryRef.current = "";
      setHits([]);
      setMore(false);
      setIndex(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api(searchPath(trimmed))
        .then((body) => {
          if (request !== requestRef.current) return;
          hitsQueryRef.current = trimmed;
          freshRef.current = true;
          setHits(Array.isArray(body?.hits) ? body.hits : []);
          setMore(body?.more === true);
        })
        .catch((error) => {
          if (request !== requestRef.current) return;
          setHits([]);
          setMore(false);
          dispatch({ type: "error", message: error instanceof Error ? error.message : "Search failed" });
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
    // searchPath reads threadId and view, both listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, query, threadId, view]);

  const land = (next: number, list: FindStop<SearchHit>[] = stops) => {
    const stop = list[next];
    if (!stop) return;
    setIndex(next);
    setFindCurrent({ messageId: stop.hit.messageId, query, occurrence: stop.occurrence });
    void landOnSearchHit(stop.hit, state, dispatch).catch((error) =>
      dispatch({ type: "error", message: error instanceof Error ? error.message : "That message is unavailable" }),
    );
  };
  // Past the oldest loaded hit: fetch the next older page, then step into it.
  const loadOlder = () => {
    const last = hits.at(-1);
    if (!last || pagingRef.current) return;
    pagingRef.current = true;
    const request = requestRef.current;
    void api(searchPath(query.trim(), last.messageId))
      .then((body) => {
        if (request !== requestRef.current) return;
        const page: SearchHit[] = Array.isArray(body?.hits) ? body.hits : [];
        const all = [...hits, ...page];
        setHits(all);
        setMore(body?.more === true && page.length > 0);
        land(stops.length, findStops(all));
      })
      .catch((error) => {
        if (request !== requestRef.current) return;
        dispatch({ type: "error", message: error instanceof Error ? error.message : "Search failed" });
      })
      .finally(() => {
        if (request === requestRef.current) pagingRef.current = false;
      });
  };
  const move = (delta: 1 | -1) => {
    const next = stepFind(index, delta, stops.length, more);
    if (next === "more") loadOlder();
    else if (next !== null) land(next);
  };

  // First result set starts on the clicked row, else the newest copy. Older pages keep the place.
  useEffect(() => {
    if (!freshRef.current || !stops.length || hitsQueryRef.current !== query.trim()) return;
    freshRef.current = false;
    const wanted = query.trim() === anchorQueryRef.current.trim() ? anchorRef.current : null;
    anchorRef.current = null;
    const next = findHitIndex(stops, wanted);
    if (next == null) return;
    land(next);
    // `land` intentionally reads the state that produced this result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, query]);

  useEffect(() => {
    const root = inputRef.current?.closest("main")?.querySelector("[data-orbit-transcript]");
    if (!(root instanceof HTMLElement)) return;
    return watchChatFindHighlight(root, query);
  }, [query]);

  const total = more ? `${stops.length}+` : stops.length;
  return (
    <div data-chat-find className="w-full px-5 pb-2">
      <div className="flex items-center gap-1.5 rounded-xl border border-hairline/50 bg-panel px-2 py-1.5 shadow-sm">
        <Search size={15} className="shrink-0 text-ink-secondary" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder={t("find.placeholder")}
          aria-label={t("find.placeholder")}
          className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
        />
        <span className="min-w-[58px] text-right text-[11.5px] tabular-nums text-ink-secondary">
          {loading ? t("find.searching") : query.trim() ? (stops.length ? t("find.of", { current: index + 1, total }) : t("find.noResults")) : ""}
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={stepFind(index, 1, stops.length, more) === null}
          aria-label={t("find.older")}
          title={t("find.older")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={stepFind(index, -1, stops.length, more) === null}
          aria-label={t("find.newer")}
          title={t("find.newer")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("find.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
