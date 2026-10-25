import { useCallback, useRef, useState, type Dispatch } from "react";

import { shownModelSelection, visibleMessages, type Action, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { withPickerEffort } from "./cross-model-picker";
import { useI18n } from "./i18n";
import type { AcceptedSend } from "./send-accept";

type SwitchStage = "saving" | "rerunning" | null;

export function noReplySource(bot: Bot) {
  return [...visibleMessages(bot)].reverse().find((message) => message.role === "user" && message.kind === "text" && !message.queued);
}

export function switchFromNoReply(bot: Bot, selection: ModelSelection, opened: string | undefined, instances: InstanceInfo[], accepted: readonly AcceptedSend[] | undefined, dispatch: Dispatch<Action>, onSwitching?: (stage: SwitchStage) => void, onRerunSettled?: () => void) {
  const shown = shownModelSelection(bot);
  const current = withPickerEffort(instances.find((instance) => instance.instanceId === shown.instanceId), shown);
  if (current.instanceId === selection.instanceId && current.model === selection.model && current.effort === selection.effort) return;
  const source = noReplySource(bot);
  // a follow-up still posting is held through the stop and runs on the new pick
  const queued = bot.messages.some((message) => message.queued) || Boolean(accepted?.some((send) => send.kind === "sends-next"));
  const finish = () => onSwitching?.(null);
  if (!source?.text || source.id !== opened) {
    finish();
    dispatch({ type: "setModel", botId: bot.id, selection });
    return;
  }
  if (bot.busy) onSwitching?.("saving");
  dispatch({
    type: "setModel", botId: bot.id, selection, holdForSwitch: true,
    onFailure: finish,
    onApplied: (picked) => {
      if (!bot.busy || !picked.busy || picked.threadId !== bot.threadId) return finish();
      dispatch({
        type: "interrupt", botId: bot.id, switchThreadId: bot.threadId,
        onFailure: finish,
        onStopped: ({ stopped, returned }) => {
          if (!stopped || queued || returned.length || !source?.text) return finish();
          onSwitching?.("rerunning");
          dispatch({ type: "editMessage", botId: bot.id, messageId: source.id, text: source.text, expectedSelection: selection, onSettled: (error) => { if (error) finish(); else onRerunSettled?.(); } });
        },
      });
    },
  });
}

export function useNoReplySwitch(bot: Bot, lastUserId: string | undefined, turnActive: boolean) {
  const pickerRef = useRef<(() => void) | null>(null);
  const key = `${bot.id}:${bot.threadId}`;
  const [transition, setTransition] = useState<{ key: string; source?: string; stage: SwitchStage; settled?: boolean } | null>(null);
  const started = transition?.key === key && transition.stage === "rerunning" && lastUserId !== undefined && lastUserId !== transition.source && (bot.busy || turnActive || transition.settled);
  if (started) setTransition(null);
  const active = transition?.key === key && !started;
  const onSwitching = useCallback((stage: SwitchStage) => setTransition(stage ? { key, source: lastUserId, stage } : null), [key, lastUserId]);
  const onRerunSettled = useCallback(() => setTransition((current) => current?.key === key && current.source === lastUserId ? { ...current, settled: true } : current), [key, lastUserId]);
  const open = useCallback(() => pickerRef.current?.(), []);
  return { pickerRef, onSwitching, onRerunSettled, open, active };
}

export function SwitchModelAction({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return <button type="button" aria-label={t("activity.switchModel")} onClick={onClick} className="pointer-events-auto shrink-0 border-0 bg-transparent p-0 text-ink-secondary hover:text-ink hover:underline hover:underline-offset-[3px]">{t("activity.switch")}</button>;
}
