import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { api, useStore, type Bot } from "@/state/store";
import { OrbitMark } from "./OrbitMark";

export function CreateBotSheet({ required }: { required: boolean }) {
  const { dispatch } = useStore();
  const [job, setJob] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = () => {
    if (!required && !saving) dispatch({ type: "closeCreateBot" });
  };

  useEffect(() => {
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
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [required, saving]);

  const submit = async () => {
    const normalized = job.trim();
    if (!normalized || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ job: normalized }),
      });
      dispatch({ type: "botAdded", bot: result.bot, focusComposer: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-app/90 p-6 backdrop-blur-lg"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-bot-title"
        aria-describedby="create-bot-help"
        className="w-full max-w-[560px] rounded-2xl border border-hairline/50 bg-panel p-7 shadow-2xl shadow-black/60"
      >
        <div className="flex items-start gap-4">
          <div className="relative shrink-0">
            <div className="absolute inset-1 rounded-full bg-accent/20 blur-xl" />
            <OrbitMark size={54} />
          </div>
          <div>
            <h1 id="create-bot-title" className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
              What should this bot handle?
            </h1>
            <p id="create-bot-help" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              Describe one ongoing job. Orbit will name the bot and pick a working engine. You can change both later.
            </p>
          </div>
        </div>

        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="create-bot-job" className="sr-only">Bot job</label>
          <textarea
            ref={inputRef}
            id="create-bot-job"
            value={job}
            maxLength={BOT_PROFILE_LIMITS.description}
            onChange={(event) => setJob(event.target.value)}
            placeholder="For example: Keep a weekly competitor brief with links and a short list of decisions I need to make."
            className="min-h-[150px] w-full resize-y rounded-xl border border-hairline/50 bg-inset px-4 py-3 text-[15px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent/70 focus:outline-none"
          />
          {error && <div role="alert" className="mt-2 text-[12.5px] text-danger">{error}</div>}
          <div className="mt-5 flex items-center justify-end gap-2.5">
            {!required && (
              <button
                type="button"
                onClick={close}
                disabled={saving}
                className="rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={!job.trim() || saving}
              className="flex min-w-[140px] items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              Start chatting
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
