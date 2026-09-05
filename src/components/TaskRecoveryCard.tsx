import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";

import { isTaskRecoveryVisible } from "@/lib/task-recovery";
import { useI18n } from "@/lib/i18n";
import { useStore, type Bot, type Message, type TaskResumePacket } from "@/state/store";
import { readContextCompaction } from "../../shared/context-compaction";

function savedAge(
  updatedAt: number,
  t: (key: import("@/lib/i18n").MessageKey, vars?: Record<string, string | number>) => string,
  botMaintained = false,
): string {
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
  if (minutes < 1) return t(botMaintained ? "chat.savedJustNowBot" : "chat.savedJustNow");
  if (minutes < 60) return t(botMaintained ? "chat.savedMinutesAgoBot" : "chat.savedMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(botMaintained ? "chat.savedHoursAgoBot" : "chat.savedHoursAgo", { count: hours });
  return t(botMaintained ? "chat.savedDaysAgoBot" : "chat.savedDaysAgo", { count: Math.floor(hours / 24) });
}

export function TaskRecoveryStrip({
  packet,
  turns,
  resuming,
  resumeError,
  onResume,
  onDismiss,
}: {
  packet: TaskResumePacket;
  turns: number;
  resuming: boolean;
  resumeError: string | null;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const stopped = packet.flushReason === "stop";
  const mayLag = turns > packet.turnsAtWrite;
  return (
    <div className="pointer-events-auto px-5 pb-2">
      <div
        role="status"
        aria-label={stopped ? t("chat.taskPaused") : t("chat.readyToContinue")}
        className="flex items-start gap-3 rounded-xl border border-hairline/30 bg-panel/70 px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-ink-secondary">
            <span className="min-w-0 truncate font-medium text-ink">{packet.goal}</span>
            <span className="shrink-0">{savedAge(packet.updatedAt, t, packet.updatedBy === "bot")}</span>
          </div>
          <p className="mt-0.5 whitespace-normal break-words text-[13px] leading-snug text-ink">
            <span className="text-ink-secondary">{t("chat.next")} </span>
            {packet.nextAction}
          </p>
          {mayLag && <p className="mt-1 text-[11px] text-warning">{t("chat.recordMayLag")}</p>}
          {resumeError && <p className="mt-1 text-[12px] text-danger">{resumeError}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={resuming}
            onClick={onResume}
            className="rounded-full border border-hairline/40 bg-raised px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-60"
          >
            {resuming ? t("chat.resuming") : t("chat.resume")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={resuming}
            aria-label={t("chat.dismissAria")}
            title={t("chat.dismiss")}
            className="flex size-6 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function TaskRecoveryCard({
  bot,
  packet,
  turns,
  busy,
}: {
  bot: Bot;
  packet: TaskResumePacket | undefined;
  turns: number;
  /** Override when the conversation busy flag is not the speaker's 1:1 busy. */
  busy?: boolean;
}) {
  const { dispatch } = useStore();
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const settleGen = useRef(0);
  useEffect(() => {
    settleGen.current += 1;
    setResuming(false);
    setResumeError(null);
  }, [bot.id, packet?.threadId]);
  if (!isTaskRecoveryVisible(packet, busy ?? bot.busy)) return null;
  return (
    <TaskRecoveryStrip
      packet={packet}
      turns={turns}
      resuming={resuming}
      resumeError={resumeError}
      onResume={() => {
        const gen = settleGen.current;
        setResuming(true);
        setResumeError(null);
        dispatch({
          type: "resumeTask",
          botId: bot.id,
          threadId: packet.threadId,
          onSettled: (error) => {
            if (gen !== settleGen.current) return;
            setResuming(false);
            if (error) setResumeError(error);
          },
        });
      }}
      onDismiss={() => dispatch({ type: "dismissTaskRecovery", botId: bot.id, threadId: packet.threadId })}
    />
  );
}

export function ContextCompactionDivider({ message }: { message: Message }) {
  const { t } = useI18n();
  const parsed = readContextCompaction({ value: message.compaction });
  if (parsed.status === "invalid") return null;
  if (parsed.status === "unsupported") {
    return (
      <div className="py-2 text-center text-[12px] text-ink-secondary">
        {t("chat.compactionUnsupported")}
      </div>
    );
  }
  return (
    <details className="group w-full py-2 text-center text-[12px] text-ink-secondary">
      <summary className="mx-auto flex w-full max-w-2xl cursor-pointer list-none select-none items-center justify-center gap-1 hover:text-ink">
        <ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" />
        {t("chat.compactionSummarized")}
      </summary>
      <div className="mx-auto mt-2 max-w-2xl whitespace-pre-wrap rounded-lg border border-hairline/30 bg-inset/25 px-3 py-2 text-left leading-relaxed">
        {parsed.value.summary}
      </div>
    </details>
  );
}
