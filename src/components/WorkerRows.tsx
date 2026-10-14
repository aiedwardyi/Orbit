import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronRight, ScrollText, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { NOTE_STATUS_KEY, noteText } from "@/lib/pane-note";
import { isPhone, PHONE_QUERY } from "@/lib/phone-swipe";
import type { Message } from "@/state/store";
import { listedRuns, listedSessionId, workerAnchors, type WorkerRun, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";

const CHIP_LIMIT = 3;

export const WORKER_STATUS = {
  working: { glyph: "●", key: "workers.working", text: "text-accent", dot: "bg-accent" },
  waiting: { glyph: "‖", key: "workers.waiting", text: "text-warning", dot: "bg-warning" },
  failed: { glyph: "!", key: "workers.failed", text: "text-danger", dot: "bg-danger" },
  done: { glyph: "✓", key: "workers.done", text: "text-success", dot: "bg-success" },
  ended: { glyph: "○", key: "workers.ended", text: "text-ink-secondary", dot: "bg-ink-secondary" },
} as const satisfies Record<WorkerShownState, { glyph: string; key: string; text: string; dot: string }>;

export type ShownRun = { run: WorkerRun; state: WorkerShownState };

export function useWorkerRows(workers: ShownRun[], messages: Message[]) {
  const anchors = useRef(new Map<string, string>());
  const workerAt = useMemo(() => workerAnchors(workers, messages, anchors.current), [messages, workers]);
  useLayoutEffect(() => {
    for (const [id, shown] of workerAt) if (shown) anchors.current.set(shown.run.id, id);
  }, [workerAt]);
  const [open, setOpen] = useState(new Set<string>());
  const toggle = useCallback((id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  return { workerAt, open, toggle };
}

export function WorkerMark({ provider, compact = false }: { provider: string | null; compact?: boolean }) {
  // brand marks stay untinted; only the script and unknown-model glyphs take the ink color
  const size = compact ? 12 : 14;
  return (
    <span className={compact ? "flex size-3 shrink-0 items-center justify-center" : "flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/40 bg-raised"}>
      {provider === "script" ? <ScrollText size={size} className="text-ink-secondary" aria-hidden /> : provider ? <ProviderMark driverKind={provider} size={size} /> : <Bot size={size} className="text-ink-secondary" aria-hidden />}
    </span>
  );
}

function WorkerStatus({ state }: { state: WorkerShownState }) {
  const { t } = useI18n();
  const status = WORKER_STATUS[state];
  return (
    <span data-worker-state={state} className={cn("flex shrink-0 items-center gap-1 text-[12.5px]", status.text)}>
      <span aria-hidden>{status.glyph}</span>
      {t(status.key)}
    </span>
  );
}

function WorkerLine({ run, state }: ShownRun) {
  return (
    <>
      <WorkerMark provider={run.provider} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate font-medium text-ink">{run.nick}</span>
        {run.model && <span className="shrink-0 text-ink-secondary">{run.model}</span>}
      </span>
      <WorkerStatus state={state} />
    </>
  );
}

/** A worker run's one transcript row; its notes fold in and open on tap. */
export function WorkerRow({ run, state, live, onOpenTerminalPane, open: expanded, onToggle }: ShownRun & { live: boolean | null; onOpenTerminalPane?: (sessionId: string) => void; open?: boolean; onToggle?: () => void }) {
  const { t } = useI18n();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const jump = live && run.sessionId && onOpenTerminalPane ? run.sessionId : null;
  const finished = state === "done" || state === "failed" || state === "ended";
  const where = finished ? "chat.launchRanIn" : live ? "chat.launchRunningIn" : "chat.launchFolder";
  return (
    <div data-worker-run={run.id} className="flex w-full flex-col">
      <button
        type="button"
        onClick={onToggle ?? (() => setLocalOpen((v) => !v))}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 border-b border-hairline/40 py-2 text-left text-[13px] hover:bg-raised/40"
      >
        <WorkerLine run={run} state={state} />
        <ChevronRight size={12} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        // pane text is untrusted; plain text only, never markdown
        <div data-orbit-worker className="flex flex-col gap-2 border-b border-hairline/40 py-2 pl-8.5 text-[12.5px] leading-relaxed text-ink-secondary">
          {run.folder && (jump ? (
            <button type="button" onClick={() => onOpenTerminalPane?.(jump)} className="self-start text-left underline-offset-2 hover:text-ink hover:underline">
              {t(where, { folder: run.folder })}
            </button>
          ) : (
            <div>{t(where, { folder: run.folder })}</div>
          ))}
          {run.notes.map(({ id, note }) => (
            <div key={id} className="whitespace-pre-wrap break-words">
              {note.status && <div className="font-medium text-ink">{t(NOTE_STATUS_KEY[note.status])}</div>}
              {noteText(note, t)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ENTRY_CLASS = "flex w-full items-center gap-2.5 border-b border-hairline/40 py-2.5 text-left text-[13px] last:border-b-0";

function WorkerEntries({ runs, livePanes, onOpenTerminalPane, onClose, inset }: { runs: ShownRun[]; livePanes: Set<string> | null; onOpenTerminalPane?: (sessionId: string) => void; onClose: () => void; inset?: boolean }) {
  const entry = cn(ENTRY_CLASS, inset && "px-3");
  return (
    <ul className="min-h-0 overflow-y-auto">
      {runs.map((shown) => {
        const sessionId = listedSessionId(shown.run, livePanes);
        if (!onOpenTerminalPane || !sessionId) {
          return (
            <li key={shown.run.id}>
              <div className={entry}>
                <WorkerLine {...shown} />
              </div>
            </li>
          );
        }
        return (
          <li key={shown.run.id}>
            <button
              type="button"
              onClick={() => {
                onOpenTerminalPane(sessionId);
                onClose();
              }}
              className={cn(entry, "hover:bg-raised/40")}
            >
              <WorkerLine {...shown} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WorkerList({ title, runs, livePanes, onClose, onOpenTerminalPane }: { title: string; runs: ShownRun[]; livePanes: Set<string> | null; onClose: () => void; onOpenTerminalPane?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);
  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        data-worker-list
        className="animate-pop-in flex max-h-[80dvh] w-full flex-col rounded-t-[24px] border border-hairline/50 bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl shadow-black/50"
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("workers.close")} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <WorkerEntries runs={runs} livePanes={livePanes} onOpenTerminalPane={onOpenTerminalPane} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

function Mark({ run, state, className }: ShownRun & { className?: string }) {
  return (
    <span data-worker-state={state} className={cn("relative flex", className)}>
      <WorkerMark provider={run.provider} />
      <span aria-hidden className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-app", WORKER_STATUS[state].dot)} />
    </span>
  );
}

/** Header chip for this chat's listed runs. Opens the worker list. */
export function WorkerChip({ name, runs, livePanes = null, waitForLive = false, onOpenTerminalPane }: { name: string; runs: ShownRun[]; livePanes?: Set<string> | null; waitForLive?: boolean; onOpenTerminalPane?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const listed = livePanes === null && waitForLive ? [] : listedRuns(runs, livePanes);
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    const flip = () => {
      setPhone(isPhone());
      setOpen(false);
    };
    media?.addEventListener?.("change", flip);
    return () => media?.removeEventListener?.("change", flip);
  }, []);
  useEffect(() => {
    if (listed.length === 0) setOpen(false);
  }, [listed.length]);
  useEffect(() => {
    if (!open || phone) return;
    let byEscape = false;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      byEscape = true;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      if (byEscape) buttonRef.current?.focus();
    };
  }, [open, phone]);
  const first = listed[0];
  if (!first) return null;
  const counts = {
    working: listed.filter((shown) => shown.state === "working").length,
    waiting: listed.filter((shown) => shown.state === "waiting").length,
    failed: listed.filter((shown) => shown.state === "failed").length,
    done: listed.filter((shown) => shown.state === "done").length,
  };
  const face = listed.slice(0, CHIP_LIMIT);
  const more = listed.length - face.length;
  const close = () => setOpen(false);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-worker-strip=""
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("workers.stripAria", counts)}
        className="relative flex shrink-0 items-center whitespace-nowrap"
      >
        <span data-worker-chip-desktop className="hidden items-center gap-1 md:flex @max-4xl/chathead:!hidden">
          {face.map((shown) => (
            <Mark key={shown.run.id} {...shown} />
          ))}
          {more > 0 && <span aria-hidden className="ml-2 text-[12px] text-ink-secondary">+{more}</span>}
        </span>
        <span data-worker-chip-phone className="relative flex items-center gap-0.5 md:hidden @max-4xl/chathead:!flex">
          <Mark {...first} />
          {listed.length >= 2 && <span aria-hidden className="text-[11px] tabular-nums text-ink-secondary">{listed.length}</span>}
          <span aria-hidden className="absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2" />
        </span>
      </button>
      {open && phone && <WorkerList title={t("workers.title", { name })} runs={listed} livePanes={livePanes} onClose={close} onOpenTerminalPane={onOpenTerminalPane} />}
      {open && !phone && (
        <div
          data-worker-list
          role="dialog"
          aria-labelledby={titleId}
          className="absolute right-0 top-full z-40 mt-1 w-[300px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1 shadow-2xl shadow-black/50"
        >
          <h2 id={titleId} className="px-3 py-2 text-[15px] font-semibold text-ink">{t("workers.title", { name })}</h2>
          <div className="max-h-[320px] overflow-y-auto">
            <WorkerEntries inset runs={listed} livePanes={livePanes} onOpenTerminalPane={onOpenTerminalPane} onClose={close} />
          </div>
        </div>
      )}
    </div>
  );
}
