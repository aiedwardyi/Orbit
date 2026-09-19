// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. Partial reply text paints incrementally above it; the
// moment the reply settles, the full bubble takes over (same left edge).
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ChatMarkdown } from "./ChatMarkdown";

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

/** The answer bubble above the mascot: settled pop-in text wins, live
 * partial text paints while the turn still works. Nothing until either
 * exists. Shared by 1:1 chat and rooms so both stream identically. */
export function PresenceAnswer({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    // Skin hooks: open-transcript skins drop the card on settled bot rows, so the pop-in must too.
    <div data-orbit-message="bot" className="contents">
      <div data-orbit-message-content className="w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={text} />
      </div>
    </div>
  );
}

export function TurnPresence({
  avatar,
  visible,
  label = "Thinking",
  answering = false,
  streaming = false,
  children,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  /** Live partial text is staged in children: paint it while the think-phase
   * label keeps shimmering. Settled answers use `answering`, which takes
   * over the label slot as before. */
  streaming?: boolean;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const showAnswer = (phase === "answer" || streaming) && children;
  const showWorking = phase === "think";
  return (
    <div className="turn-presence flex flex-col items-start">
      {showAnswer ? <div className="turn-answer">{children}</div> : null}
      <div
        className={cn(
          "flex items-center gap-2",
          showAnswer && "turn-mascot-tight",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {showWorking ? (
          <span className="thinking-shimmer text-[13px] leading-none" aria-live="polite">
            {label}
            <span className="thinking-sheen" aria-hidden="true">
              <span>{label}</span>
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
