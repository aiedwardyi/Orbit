// Engine mark with a hover card naming the account the engine bills. Opens
// on hover and keyboard focus; on phones a hold opens it, only where the
// mark sits outside a button or link that already owns the tap.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useI18n, type Translate } from "@/lib/i18n";
import { placeTooltip } from "@/lib/tooltip-position";
import { TOOLTIP_SHOW_MS } from "@/lib/tooltips";
import { usePresence } from "@/lib/use-presence";
import { useBackLayer } from "@/lib/use-back-layer";
import type { InstanceInfo } from "@/state/store";
import { HOLD_MS, HOLD_SLOP, MENU_CLASS } from "./MessageMenu";
import { ProviderMark } from "./ProviderIcons";

const OWNS_TAP = "button, a[href], [role='button'], [role='tab'], [tabindex]:not([tabindex='-1'])";

// Same rule as the row's own sign-in control: anything short of signed in reads as not signed in.
export function engineHoverText(instance: InstanceInfo, t: Translate): string {
  const { snapshot } = instance;
  const signedIn = snapshot.state === "available" && snapshot.authenticated === true;
  const status = signedIn ? snapshot.account || t("engines.signedIn") : t("engines.notSignedIn");
  return t("engines.accountLine", { engine: instance.displayName, status });
}

export function EngineMark({ instance, size, className, children }: { instance: InstanceInfo; size?: number; className?: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <EngineHover text={engineHoverText(instance, t)} label={children}>
      <ProviderMark driverKind={instance.driverKind} size={size} className={className} />
    </EngineHover>
  );
}

function EngineHover({ text, label, children }: { text: string; label?: ReactNode; children: ReactNode }) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const [owner, setOwner] = useState<HTMLElement | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const presence = usePresence(open);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    hold.current = null;
  };
  const close = () => {
    cancel();
    setOpen(false);
  };
  useBackLayer(open, close);

  useLayoutEffect(() => {
    setOwner(triggerRef.current?.parentElement?.closest<HTMLElement>(OWNS_TAP) ?? null);
  }, []);

  // Inside a button the button takes focus, so its keyboard focus opens the card.
  useEffect(() => {
    if (!owner) return;
    const onFocus = () => {
      if (owner.matches(":focus-visible")) setOpen(true);
    };
    const onBlur = () => setOpen(false);
    owner.addEventListener("focusin", onFocus);
    owner.addEventListener("focusout", onBlur);
    return () => {
      owner.removeEventListener("focusin", onFocus);
      owner.removeEventListener("focusout", onBlur);
    };
  }, [owner]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !triggerRef.current?.contains(e.target)) close();
    };
    // Same rule as plain tips: a transcript follow scroll elsewhere must not close it.
    const onScroll = (e: Event) => {
      const anchor = triggerRef.current;
      if (e.target === document || (anchor && e.target instanceof Node && e.target.contains(anchor))) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  useEffect(() => cancel, []);

  useLayoutEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const anchor = triggerRef.current;
    if (!card || !anchor) return;
    const box = anchor.getBoundingClientRect();
    setPlace(placeTooltip({
      anchor: box,
      // offset sizes ignore the pop-in scale
      size: { width: card.offsetWidth, height: card.offsetHeight },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, [open, text]);

  useEffect(() => {
    if (!presence.mounted) setPlace(null);
  }, [presence.mounted]);

  const standalone = owner === null;
  // A label inside must still read as text, so the account line moves onto the mark alone.
  const markRole = standalone ? "img" : undefined;
  const markLabel = standalone ? text : undefined;
  return (
    <>
      <span
        ref={triggerRef}
        data-engine-hover=""
        tabIndex={standalone ? 0 : undefined}
        role={label ? undefined : markRole}
        aria-label={label ? undefined : markLabel}
        className={cn("inline-flex shrink-0 rounded-sm", label && "min-w-0 shrink items-center gap-2", standalone && "select-none [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-text")}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          cancel();
          timer.current = setTimeout(() => setOpen(true), TOOLTIP_SHOW_MS);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") close();
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") close();
          if (e.pointerType !== "touch" || !standalone) return;
          if (open) {
            close();
            return;
          }
          cancel();
          held.current = false;
          hold.current = { x: e.clientX, y: e.clientY };
          timer.current = setTimeout(() => {
            held.current = true;
            setOpen(true);
          }, HOLD_MS);
        }}
        onPointerMove={(e) => {
          if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > HOLD_SLOP) cancel();
        }}
        onPointerUp={() => hold.current && cancel()}
        onPointerCancel={() => hold.current && cancel()}
        onContextMenu={(e) => {
          if (held.current) e.preventDefault();
        }}
        onFocus={(e) => {
          if (standalone && e.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => standalone && close()}
      >
        {label ? (
          <>
            <span role={markRole} aria-label={markLabel} className="inline-flex shrink-0">{children}</span>
            {label}
          </>
        ) : children}
      </span>
      {presence.mounted && createPortal(
        <div
          ref={cardRef}
          id={id}
          role="tooltip"
          data-engine-card=""
          data-closing={presence.closing || undefined}
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
          className={cn(MENU_CLASS, "pointer-events-none z-[70] max-w-[min(20rem,calc(100vw-1rem))] px-3.5 py-2 text-[14px] leading-snug text-ink [overflow-wrap:anywhere]")}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
