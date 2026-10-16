import { memo, useEffect, useRef, type RefObject } from "react";

import { localeTag, useI18n } from "@/lib/i18n";
import { useSkin } from "@/lib/skins";
import { catchUpTurns, loadTurns } from "@/lib/turn-index";
import { createTurnRail, type TurnRail as Rail } from "@/lib/turn-rail-view";
import type { Message } from "@/state/store";

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const format = (cache: Map<string, Intl.DateTimeFormat>, key: string, make: () => Intl.DateTimeFormat) => {
  let made = cache.get(key);
  if (!made) cache.set(key, (made = make()));
  return made;
};

/** The timeline rail at the transcript's edge. Nothing loads until the pointer or a thumb comes near it. */
export const TurnRail = memo(function TurnRail({
  threadId,
  messages,
  scrollRef,
  following,
  enabled,
  mirror,
  latestShown,
  onJump,
  onLatest,
  onWheel,
}: {
  threadId: string;
  /** The chat's live list, for turns sent after the index loaded. */
  messages: readonly Message[];
  scrollRef: RefObject<HTMLDivElement | null>;
  following: boolean;
  enabled: boolean;
  mirror: boolean;
  /** The Jump to latest pill is up; the card keeps clear of it. */
  latestShown: boolean;
  onJump: (messageId: string) => void;
  onLatest: () => void;
  onWheel: (deltaY: number) => void;
}) {
  const { t, locale } = useI18n();
  const skin = useSkin();
  const hostRef = useRef<HTMLDivElement>(null);
  const rail = useRef<Rail | null>(null);
  const latest = useRef({ threadId, messages, onJump, onLatest, onWheel, t, locale });
  latest.current = { threadId, messages, onJump, onLatest, onWheel, t, locale };

  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (!host || !scroller) return;
    const time = (ms: number) => format(timeFormats, latest.current.locale, () => new Intl.DateTimeFormat(localeTag(latest.current.locale), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(ms);
    const day = (ms: number) => {
      const year = new Date(ms).getFullYear() !== new Date().getFullYear();
      return format(dayFormats, `${latest.current.locale}:${year}`, () =>
        new Intl.DateTimeFormat(localeTag(latest.current.locale), { weekday: "short", month: "short", day: "numeric", year: year ? "numeric" : undefined }),
      ).format(ms);
    };
    const created = createTurnRail(host, scroller, {
      turns: () => {
        const id = latest.current.threadId;
        return loadTurns(id).then(
          (turns) => {
            if (latest.current.threadId === id) catchUpTurns(turns, latest.current.messages);
            return turns;
          },
          () => null,
        );
      },
      catchUp: (turns) => catchUpTurns(turns, latest.current.messages),
      jump: (messageId) => latest.current.onJump(messageId),
      latest: () => latest.current.onLatest(),
      wheel: (deltaY) => latest.current.onWheel(deltaY),
      day,
      time,
      label: () => latest.current.t("timeline.label"),
      valueText: (ms, words) => latest.current.t("timeline.turn", { day: day(ms), time: time(ms), words }),
    });
    rail.current = created;
    return () => {
      created.destroy();
      rail.current = null;
    };
  }, [scrollRef]);

  useEffect(() => rail.current?.setThread(threadId), [threadId]);
  useEffect(() => rail.current?.setMirror(mirror), [mirror]);
  useEffect(() => rail.current?.setFollowing(following), [following]);
  useEffect(() => rail.current?.restyle(), [skin, locale]);
  useEffect(() => rail.current?.setEnabled(enabled), [enabled]);
  useEffect(() => rail.current?.setLatestShown(latestShown), [latestShown]);
  useEffect(() => rail.current?.liveChanged(), [messages]);

  return <div ref={hostRef} className="turn-rail-host" />;
});
