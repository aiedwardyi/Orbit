import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, SquareTerminal, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { NOTE_STATUS_KEY, noteText } from "@/lib/pane-note";
import { byUrgency, type WorkerRun, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";

const STRIP_LIMIT = 5;

export const WORKER_STATUS = {
  working: { glyph: "●", key: "workers.working", text: "text-accent", dot: "bg-accent" },
  waiting: { glyph: "?", key: "workers.waiting", text: "text-warning", dot: "bg-warning" },
  failed: { glyph: "!", key: "workers.failed", text: "text-danger", dot: "bg-danger" },
  done: { glyph: "✓", key: "workers.done", text: "text-success", dot: "bg-success" },
  ended: { glyph: "○", key: "workers.ended", text: "text-ink-secondary", dot: "bg-ink-secondary" },
} as const satisfies Record<WorkerShownState, { glyph: string; key: string; text: string; dot: string }>;

export type ShownRun = { run: WorkerRun; state: WorkerShownState };

function WorkerMark({ provider }: { provider: string | null }) {
  // brand marks stay untinted; only the script glyph takes the ink color
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/40 bg-raised">
      {provider && provider !== "script" ? <ProviderMark driverKind={provider} size={14} /> : <SquareTerminal size={14} className="text-ink-secondary" aria-hidden />}
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
export function WorkerRow({ run, state, live, onOpenTerminalPane }: ShownRun & { live: boolean | null; onOpenTerminalPane?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const jump = live && run.sessionId && onOpenTerminalPane ? run.sessionId : null;
  const finished = state === "done" || state === "failed" || state === "ended";
  const where = finished ? "chat.launchRanIn" : live ? "chat.launchRunningIn" : "chat.launchFolder";
  return (
    <div data-worker-run={run.id} className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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

function WorkerList({ title, runs, onClose }: { title: string; runs: ShownRun[]; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);
  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px] md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        data-worker-list
        className="animate-pop-in flex max-h-[80dvh] w-full flex-col rounded-t-[24px] border border-hairline/50 bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl shadow-black/50 md:max-w-[440px] md:rounded-[24px] md:pb-5"
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("workers.close")} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink md:size-8">
            <X size={16} />
          </button>
        </div>
        <ul className="min-h-0 overflow-y-auto">
          {runs.map((shown) => (
            <li key={shown.run.id} className="flex items-center gap-2.5 border-b border-hairline/40 py-2.5 text-[13px] last:border-b-0">
              <WorkerLine {...shown} />
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

/** Marks for this chat's live runs, above the composer; opens the full list. */
export function WorkerStrip({ name, runs }: { name: string; runs: ShownRun[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const active = runs.filter((shown) => shown.state === "working" || shown.state === "waiting").sort(byUrgency);
  if (active.length === 0 && !open) return null;
  const waiting = active.filter((shown) => shown.state === "waiting").length;
  const shown = active.slice(0, STRIP_LIMIT);
  const more = active.length - shown.length;
  return (
    <>
      {active.length > 0 && (
        <button
          type="button"
          data-worker-strip
          onClick={() => setOpen(true)}
          aria-label={t("workers.stripAria", { working: active.length - waiting, waiting })}
          className="flex h-11 w-full items-center gap-1.5 px-5 md:h-8"
        >
          {shown.map(({ run, state }) => (
            <span key={run.id} data-worker-state={state} className="relative flex">
              <WorkerMark provider={run.provider} />
              <span aria-hidden className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-app", WORKER_STATUS[state].dot)} />
            </span>
          ))}
          {more > 0 && <span aria-hidden className="pl-0.5 text-[12px] text-ink-secondary">+{more}</span>}
        </button>
      )}
      {open && <WorkerList title={t("workers.title", { name })} runs={[...runs].sort(byUrgency)} onClose={() => setOpen(false)} />}
    </>
  );
}
