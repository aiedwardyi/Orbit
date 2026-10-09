import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { api, useStore, type Bot } from "@/state/store";
import { defaultModelSelection } from "@/lib/default-engine";
import { OrbitMark } from "./OrbitMark";
import { useI18n } from "@/lib/i18n";

export function CreateBotSheet({
  required,
  closing = false,
  initialSection,
  onCreated,
  onClose,
}: {
  required: boolean;
  closing?: boolean;
  initialSection?: string;
  onCreated?: (bot: Bot) => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canPick = Boolean(window.ogb?.pickFolder);

  const close = () => {
    if (!required && !saving) {
      dispatch({ type: "closeCreateBot" });
      onClose?.();
    }
  };

  useEffect(() => {
    if (closing) return;
    inputRef.current?.focus();
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !required) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!controls.length) return event.preventDefault();
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [closing, required, saving]);

  const pick = async () => {
    let chosen: string | null | undefined;
    try {
      chosen = await window.ogb?.pickFolder?.(folder.trim() || undefined);
    } catch {
      return;
    }
    if (chosen) setFolder(chosen);
  };

  const submit = async () => {
    const normalized = name.trim();
    if (saving || !normalized) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedFolder = folder.trim();
      // The available-engine snapshot is already on hand: send the resolved
      // default explicitly so the server skips full provider discovery
      // (checkedModelSelection does no catalog/health I/O). With no usable
      // engine the field stays out and the server path is unchanged.
      const selection = defaultModelSelection(state.instances);
      const payload = {
        name: normalized,
        cwd: trimmedFolder || undefined,
        section: initialSection?.trim() || undefined,
        modelSelection: selection ?? undefined,
      };
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      dispatch({ type: "botAdded", bot: result.bot, focusComposer: !onCreated, activate: !onCreated });
      onCreated?.(result.bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-app/90 p-6 backdrop-blur-lg"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-labelledby="create-bot-title"
        className="animate-pop-in max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[560px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/60 sm:p-7"
      >
        {/* Stacked below sm so the title shares the form's left edge. */}
        <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-start max-sm:gap-3">
          <div className="relative shrink-0">
            <div className="absolute inset-1 rounded-full bg-accent/20 blur-xl" />
            <OrbitMark size={54} />
          </div>
          <h1 id="create-bot-title" className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
            {t("createBot.title")}
          </h1>
        </div>

        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="create-bot-name" className="mb-1.5 block text-[13px] text-ink-secondary">{t("createBot.nameLabel")}</label>
          <input
            ref={inputRef}
            id="create-bot-name"
            value={name}
            maxLength={BOT_PROFILE_LIMITS.name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // An IME confirm-Enter must not submit the half-composed edit.
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("createBot.namePlaceholder")}
            className="w-full rounded-xl border border-hairline/50 bg-inset px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-accent/70 focus:outline-none"
          />
          <div className="mt-4">
            <label htmlFor="create-bot-folder" className="mb-1.5 block text-[13px] text-ink-secondary">
              {t("bot.workingFolder")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="create-bot-folder"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                placeholder={t("bot.workingFolderPlaceholder")}
                className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-4 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent/70 focus:outline-none"
              />
              {canPick && (
                <button
                  type="button"
                  onClick={() => void pick()}
                  disabled={saving}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-control px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  <FolderOpen size={14} /> {t("bot.workingFolderChoose")}
                </button>
              )}
              {folder.trim() && (
                <button
                  type="button"
                  onClick={() => setFolder("")}
                  disabled={saving}
                  className="shrink-0 rounded-xl px-2 py-2.5 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50"
                >
                  {t("bot.workingFolderClear")}
                </button>
              )}
            </div>
          </div>
          {error && <div role="alert" className="mt-2 text-[12.5px] text-danger">{error}</div>}
          <div className="mt-5 flex items-center justify-end gap-2.5">
            {!required && (
              <button
                type="button"
                onClick={close}
                disabled={saving}
                className="rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 max-sm:flex-1"
              >
                {t("createBot.cancel")}
              </button>
            )}
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="flex min-w-[140px] items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 max-sm:min-w-0 max-sm:flex-1"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              {saving ? t("createBot.adding") : t("createBot.start")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
