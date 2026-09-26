import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const TOPIC_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomPhonePingTopic(length = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => TOPIC_CHARS[byte % TOPIC_CHARS.length]).join("");
}

export function PhonePingSettings() {
  const { t } = useI18n();
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [test, setTest] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api("/api/phone-ping")
      .then((body: { topic?: string }) => {
        if (!live) return;
        setSaved(body.topic ?? "");
        setValue(body.topic ?? "");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const save = async (next: string) => {
    if (next.trim() === saved) return;
    try {
      const body: { topic: string } = await api("/api/phone-ping", { method: "PUT", body: JSON.stringify({ topic: next }) });
      setSaved(body.topic);
      setValue(body.topic);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.phonePing.saveError"));
    }
  };

  const sendTest = async () => {
    if (busy) return;
    setBusy(true);
    setTest(null);
    try {
      await api("/api/phone-ping/test", { method: "POST", body: JSON.stringify({ topic: value }) });
      setTest({ kind: "ok", message: t("settings.phonePing.testOk") });
    } catch (cause) {
      setTest({ kind: "error", message: cause instanceof Error ? cause.message : t("settings.phonePing.testError") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("settings.phonePing.title")} subtitle={t("settings.phonePing.help")}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("settings.phonePing.placeholder")}
          aria-label={t("settings.phonePing.aria")}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
            setTest(null);
          }}
          onBlur={() => void save(value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={`min-w-0 flex-1 basis-full sm:basis-0 rounded-lg border bg-inset px-3 py-2 font-mono text-[13px] text-ink focus:outline-none ${
            error ? "border-danger/60" : "border-hairline/40 focus:border-hairline"
          }`}
        />
        <button
          type="button"
          onClick={() => {
            const topic = randomPhonePingTopic();
            setValue(topic);
            setTest(null);
            void save(topic);
          }}
          className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70"
        >
          {t("settings.phonePing.generate")}
        </button>
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void sendTest()}
          className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("settings.phonePing.test")}
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      {test ? (
        <p role={test.kind === "error" ? "alert" : "status"} className={`mt-2 text-[12px] ${test.kind === "error" ? "text-danger" : "text-ink-secondary"}`}>
          {test.message}
        </p>
      ) : null}
    </Card>
  );
}
