import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { disableWebPush, enableWebPush, readWebPushState, testWebPush, type WebPushState } from "@/lib/web-push";
import { Section } from "./SettingsPrimitives";

export function PhoneNotificationSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<WebPushState | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    readWebPushState()
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setState("off");
      });
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (cause) {
      setNote({ kind: "error", message: cause instanceof Error ? cause.message : fallback });
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  const button = "rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <Section title={t("settings.phoneNotifications.title")} subtitle={t("settings.phoneNotifications.help")}>
      <div className="flex flex-wrap items-center gap-2">
        <span data-web-push-state={state} className="min-w-0 flex-1 text-[13px] text-ink-secondary">
          {t(`settings.phoneNotifications.state.${state}`)}
        </span>
        {state === "off" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setState(await enableWebPush()), t("settings.phoneNotifications.enableError"))}
            className={button}
          >
            {t("settings.phoneNotifications.enable")}
          </button>
        ) : null}
        {state === "on" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await testWebPush();
                  setNote({ kind: "ok", message: t("settings.phoneNotifications.testOk") });
                }, t("settings.phoneNotifications.testError"))
              }
              className={button}
            >
              {t("settings.phoneNotifications.test")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await disableWebPush();
                  setState("off");
                }, t("settings.phoneNotifications.disableError"))
              }
              className={button}
            >
              {t("settings.phoneNotifications.disable")}
            </button>
          </>
        ) : null}
      </div>
      {note ? (
        <p role={note.kind === "error" ? "alert" : "status"} className={`mt-2 text-[12px] ${note.kind === "error" ? "text-danger" : "text-ink-secondary"}`}>
          {note.message}
        </p>
      ) : null}
    </Section>
  );
}
