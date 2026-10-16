// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A run stays open once you open it, and search can
// force it open so a hit is not stuck behind the fold. A failure shows as a
// quiet cross beside the summary; the row itself never goes red.
import { useEffect, useState } from "react";
import { Bot, ChevronRight, Check, FileText, Globe, Loader2, Pencil, Search, SquareTerminal, Wrench, X } from "lucide-react";
import type { Message } from "@/state/store";
import { classifyServerNotice, describeRun, describeSearch, localizeServerLine, type LinkedApproval } from "@/lib/activity-runs";
import { useI18n, type Translate } from "@/lib/i18n";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { APPROVAL_WORD, TERM_STEP_WORD, termBlock, termHeaderArgs, termResultLine, termStepAria, termStepState, termUpdatedLine, termVerb } from "@/lib/terminal-skin";

function StepStatus({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <Loader2 size={13} className="shrink-0 animate-spin" />;
  if (ok === false) return <X size={13} strokeWidth={1.5} className="shrink-0" />;
  return <Check size={13} className="shrink-0 text-success" />;
}

function stepIcon(name: string) {
  if (name === "Read") return FileText;
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return Pencil;
  if (name === "Bash") return SquareTerminal;
  if (name === "Grep" || name === "Glob") return Search;
  if (name === "WebFetch" || name === "WebSearch") return Globe;
  if (name === "Agent" || name === "Task") return Bot;
  return Wrench;
}

const formatDuration = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

export function approvalHover(notices: LinkedApproval[] | undefined, t: Translate): string | undefined {
  if (!notices?.length) return undefined;
  return notices.map((notice) => t(APPROVAL_WORD[notice.label])).join(" · ");
}

function TermNotice({ text, failed }: { text: string; failed: boolean }) {
  return <div className="term-notice" data-term-notice={failed ? "failed" : "ok"}>{text}</div>;
}

/** One step inside an open run. A running step ticks its elapsed time, then
 * settles in the same row: same key, same element, only the status swaps. */
export function ActivityStep({ message, notices }: { message: Message; notices?: LinkedApproval[] }) {
  const { t } = useI18n();
  const terminal = isTerminalSkin(useSkin());
  const tool = message.tool;
  const running = tool?.ok === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  if (!tool) return null;
  const notice = classifyServerNotice(tool.name);
  if (terminal && notice) {
    const text = notice.kind === "approval" ? t(APPROVAL_WORD[notice.label]) : tool.name;
    return <TermNotice text={text} failed={tool.ok === false} />;
  }
  const Icon = stepIcon(tool.name);
  const elapsed = running ? Math.max(0, now - new Date(message.at).getTime()) : tool.durationMs;
  const shown = localizeServerLine(tool.name, t);
  if (terminal) return <TermStep name={shown} rawVerb={tool.verb} summary={tool.summary} ok={tool.ok} elapsed={elapsed} detail={tool.detail} notices={notices} />;
  return (
    <div title={approvalHover(notices, t)} className="flex max-w-[min(42rem,100%)] items-center gap-2 px-3 py-0.5 text-[13px] text-ink-secondary">
      <Icon size={13} className="shrink-0" />
      <span className="shrink-0 text-ink">{shown}</span>
      {tool.summary && <span className="min-w-0 truncate font-mono text-[12px]">{tool.summary}</span>}
      <StepStatus ok={tool.ok} />
      <span className="ml-auto shrink-0 pl-3 text-[12px] tabular-nums">{elapsed === undefined ? "" : formatDuration(elapsed)}</span>
    </div>
  );
}

type ToolDetail = NonNullable<Message["tool"]>["detail"];

/** Claude Code's call: `● Verb(args)` over its output, or one `⎿ Done (1.2s)` line. */
function TermStep({ name, rawVerb, summary, ok, elapsed, detail, notices }: { name: string; rawVerb?: string; summary?: string; ok: boolean | undefined; elapsed: number | undefined; detail?: ToolDetail; notices?: LinkedApproval[] }) {
  const { t } = useI18n();
  const verb = termVerb(rawVerb ?? name);
  const state = termStepState(ok);
  const aria = termStepAria(state, elapsed);
  const args = termHeaderArgs(verb, summary, detail, rawVerb ? name : undefined);
  const block = termBlock(detail, state === "failed");
  return (
    <div data-term-step={state} className="term-step min-w-0 max-w-full">
      <span className="sr-only">{t(aria.key, { tool: summary ? `${verb} ${summary}` : verb, seconds: aria.seconds ?? 0 })}</span>
      <div aria-hidden="true" className="term-step-head">
        <span className="font-semibold text-ink">{verb}</span>
        {args && `(${args})`}
      </div>
      {block?.kind === "hidden" ? (
        <div className="term-step-out">{t("term.step.hidden")}</div>
      ) : block ? (
        <div className="term-step-out">
          {block.changes && detail?.input && <div>{termUpdatedLine(t, detail.input, block.changes)}</div>}
          {block.rows.map((row, index) => <div key={index} data-term-row={row.tone}>{row.text}</div>)}
          {block.more && <div>{t(block.more === 1 ? "term.step.moreOne" : "term.step.moreMany", { count: block.more })}</div>}
        </div>
      ) : (
        <div aria-hidden="true" className="term-step-result truncate">{termResultLine(t(TERM_STEP_WORD[state]), elapsed)}</div>
      )}
      {notices?.map((notice) => <TermNotice key={notice.message.id} text={t(APPROVAL_WORD[notice.label])} failed={false} />)}
    </div>
  );
}

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const terminal = isTerminalSkin(useSkin());
  const failed = messages.some((message) => message.tool?.ok === false);
  const running = messages.some((message) => message.tool?.ok === undefined);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (terminal) {
    return (
      <div className="flex flex-col">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="term-search self-start text-left">
          {describeSearch(messages)}
          {running && <span> · {t("task.running")}</span>}
          {failed && <span> · {t("workers.failed")}</span>}
        </button>
        {open && children}
      </div>
    );
  }
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:bg-control"
          >
            <ChevronRight size={13} className="rotate-90" />
            <span>{describeRun(messages)} ·</span>
            <StepStatus ok={running ? undefined : !failed} />
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Show every step"
        className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:bg-control"
      >
        <span className="max-w-[480px] truncate">{describeRun(messages)} ·</span>
        <StepStatus ok={running ? undefined : !failed} />
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
