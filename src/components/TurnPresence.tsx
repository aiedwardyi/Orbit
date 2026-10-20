// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. Once reply text shows, it docks in that reply's action
// strip instead, and fades out there when the turn ends.
import { cloneElement, Component, isValidElement, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { termElapsed } from "@/lib/terminal-skin";
import type { Message } from "@/state/store";
import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { OrbitMark } from "./OrbitRing";

/** One bad markdown node must not white-screen the app — the bubble
 * degrades to plain text instead. Partial fence runs make this the rule
 * rather than the exception while streaming, so new text resets the trip:
 * every delta retries the render instead of sticking on the first bad one. */
export class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean; text: string }> {
  state = { failed: false, text: this.props.fallbackText };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { children: ReactNode; fallbackText: string },
    state: { failed: boolean; text: string },
  ) {
    if (props.fallbackText !== state.text) return { failed: false, text: props.fallbackText };
    return null;
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

export type ReplyDock = { slot: string; live: boolean; avatar: ReactNode; label: string; since?: number };

// The parent identifies a reply slot before the server assigns its message id.
export function replySlot(threadId: string, message: Message, transcript: Message[]) {
  return `reply:${threadId}:${message.parentId ?? transcript[transcript.indexOf(message) - 1]?.id ?? ""}`;
}

/** Docks in the streaming reply, and only keeps a finished one to fade out.
 * A live dock after the buffer clears hides that reply's actions and sits on its time. */
export function useReplyDock(liveSlot: string | null, tailSlot: string | null, waiting: boolean) {
  const [dock, setDock] = useState<{ slot: string; live: boolean } | null>(null);
  const next = liveSlot
    ? { slot: liveSlot, live: true }
    : dock && dock.slot === tailSlot && !waiting
      ? { slot: dock.slot, live: false }
      : null;
  // Render-phase setState: React re-renders at once with the new dock.
  if (next?.slot !== dock?.slot || next?.live !== dock?.live) setDock(next);
  return next;
}

export function TurnPresence({
  avatar,
  visible,
  docked = false,
  label = "Thinking",
  since,
}: {
  avatar: ReactNode;
  visible: boolean;
  /** The mascot moved under live reply text: leave at once, no exit fade. */
  docked?: boolean;
  label?: string;
  /** When the turn began; the Terminal skin counts up from it. */
  since?: number;
}) {
  const terminal = isTerminalSkin(useSkin());
  const [wasVisible, setWasVisible] = useState(visible);
  const [fading, setFading] = useState(false);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    setFading(!visible && !docked);
  }

  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(false), 280);
    return () => clearTimeout(timer);
  }, [fading]);

  if (docked || (!visible && !fading)) return null;
  return (
    <div className="turn-presence flex flex-col items-start">
      <div data-turn-mascot className={cn("flex max-w-full items-center gap-2", visible ? "turn-mascot-in" : "turn-mascot-out")}>
        {terminal ? <TermGlyph ring={visible} /> : ringFace(avatar, visible)}
        {visible ? <WorkingLabel label={label} /> : null}
        {visible && terminal && since ? <Elapsed since={since} /> : null}
      </div>
    </div>
  );
}

/** True while the docked mascot is live or still fading out. */
export function useDockFade(live: boolean): boolean {
  const [gone, setGone] = useState(!live);
  if (live && gone) setGone(false);

  useEffect(() => {
    if (live) return;
    const timer = setTimeout(() => setGone(true), 280);
    return () => clearTimeout(timer);
  }, [live]);

  return !gone;
}

/** The mascot docked in a live reply's action strip. It fades out in place
 * when the turn ends, so the reply's own actions take the strip unmoved. */
export function DockedPresence({ avatar, label, live, since, className }: { avatar: ReactNode; label: string; live: boolean; since?: number; className?: string }) {
  const terminal = isTerminalSkin(useSkin());
  if (!useDockFade(live)) return null;
  return (
    <div
      data-turn-mascot
      aria-hidden={!live}
      className={cn("turn-mascot-docked pointer-events-none flex w-max max-w-[min(20rem,calc(100vw-4rem))] items-center gap-1.5", live ? "turn-mascot-in" : "turn-mascot-out", className)}
    >
      {terminal ? <TermGlyph ring={live} /> : ringFace(avatar, live)}
      {live ? <WorkingLabel label={label} /> : null}
      {live && terminal && since ? <Elapsed since={since} /> : null}
    </div>
  );
}

function ringFace(avatar: ReactNode, on: boolean): ReactNode {
  if (isValidElement<BotAvatarProps>(avatar) && avatar.type === BotAvatar) {
    return cloneElement(avatar, { orbitRing: on });
  }
  if (!on) return avatar;
  return <OrbitMark>{avatar}</OrbitMark>;
}

function TermGlyph({ ring = false }: { ring?: boolean }) {
  const mark = (
    <span aria-hidden="true" className="term-blink text-[15px] leading-none text-accent">
      ✽
    </span>
  );
  if (!ring) return mark;
  return <OrbitMark>{mark}</OrbitMark>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="shrink-0 text-[13px] leading-none whitespace-nowrap text-ink-secondary tabular-nums">({termElapsed(now - since)})</span>;
}

function WorkingLabel({ label }: { label: string }) {
  return (
    <span className="thinking-shimmer min-w-0 text-[13px] leading-none whitespace-nowrap text-ellipsis" aria-live="polite">
      {label}
      <span className="thinking-sheen" aria-hidden="true">
        <span className="overflow-x-clip text-ellipsis">{label}</span>
      </span>
    </span>
  );
}
