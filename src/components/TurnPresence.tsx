// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. Once reply text shows, it docks in that reply's action
// strip instead, and fades out there when the turn ends.
import { Component, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Message } from "@/state/store";

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

export type ReplyDock = { slot: string; live: boolean; avatar: ReactNode; label: string };

// The parent identifies a reply slot before the server assigns its message id.
export function replySlot(threadId: string, message: Message, transcript: Message[]) {
  return `reply:${threadId}:${message.parentId ?? transcript[transcript.indexOf(message) - 1]?.id ?? ""}`;
}

/** The reply slot the mascot docks in: the live reply once its text shows,
 * kept until a row lands below it, and no longer live once the turn ends. */
export function useReplyDock(liveSlot: string | null, tailSlot: string | null, waiting: boolean) {
  const [dock, setDock] = useState<{ slot: string; live: boolean } | null>(null);
  const next = liveSlot
    ? { slot: liveSlot, live: true }
    : dock && dock.slot === tailSlot ? { slot: dock.slot, live: dock.live && waiting } : null;
  if (next?.slot !== dock?.slot || next?.live !== dock?.live) setDock(next);
  return next;
}

export function TurnPresence({
  avatar,
  visible,
  docked = false,
  label = "Thinking",
}: {
  avatar: ReactNode;
  visible: boolean;
  /** The mascot moved under live reply text: leave at once, no exit fade. */
  docked?: boolean;
  label?: string;
}) {
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
      <div data-turn-mascot className={cn("flex items-center gap-2", visible ? "turn-mascot-in" : "turn-mascot-out")}>
        {avatar}
        {visible ? <WorkingLabel label={label} /> : null}
      </div>
    </div>
  );
}

/** The mascot docked in a live reply's action strip. It fades out in place
 * when the turn ends, so the reply's own actions take the strip unmoved. */
export function DockedPresence({ avatar, label, live, className }: { avatar: ReactNode; label: string; live: boolean; className?: string }) {
  const [gone, setGone] = useState(!live);
  if (live && gone) setGone(false);

  useEffect(() => {
    if (live) return;
    const timer = setTimeout(() => setGone(true), 280);
    return () => clearTimeout(timer);
  }, [live]);

  if (gone) return null;
  return (
    <div
      data-turn-mascot
      aria-hidden={!live}
      className={cn("turn-mascot-docked pointer-events-none flex items-center gap-1.5", live ? "turn-mascot-in" : "turn-mascot-out", className)}
    >
      {avatar}
      {live ? <WorkingLabel label={label} /> : null}
    </div>
  );
}

function WorkingLabel({ label }: { label: string }) {
  return (
    <span className="thinking-shimmer text-[13px] leading-none" aria-live="polite">
      {label}
      <span className="thinking-sheen" aria-hidden="true">
        <span>{label}</span>
      </span>
    </span>
  );
}
