import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import {
  credentialConfigPatch,
  credentialResumeOutcome,
  customKeyRecord,
  type CredentialTargetId,
} from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const secret = message.secret!;
  const service = secret.service;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const description = provided
    ? secret.resumed
      ? t("secret.savedContinuing")
      : t("secret.savedWillContinue")
    : declined
      ? t("secret.declined")
      : secret.description;
  const footerLabel = declined
    ? t("secret.footerDeclineFailed")
    : secret.resumed
      ? t("secret.footerResumed")
      : error
        ? t("secret.footerResumeFailed")
        : t("secret.footerWaiting");

  // A successful decline has no durable card to show. If its continuation
  // failed, bring the card back with the same retry affordance as a saved key.
  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        const next = value.trim();
        // A custom key saves with the exact binding this card shows.
        const status: ConfigStatus = window.ogb?.setCredential
          ? await window.ogb.setCredential(secret.target, service ? JSON.stringify(customKeyRecord(service, next)) : next)
          : await api("/api/config", {
              method: "PUT",
              body: JSON.stringify(service
                ? { customKeys: { [service.host]: customKeyRecord(service, next) } }
                : credentialConfigPatch(secret.target as CredentialTargetId, next)),
            });
        dispatch({ type: "configStatus", config: status });
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink">
            <KeyRound size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{secret.label}</span>
              {provided && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> {t("secret.saved")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {description}
            </p>
            {service && !provided && !declined && (
              <div className="mt-2 rounded-lg border border-hairline/60 bg-panel/60 px-3 py-2">
                <div className="break-all text-[17px] font-semibold text-ink">{service.name}</div>
                <div className="mt-0.5 break-all text-[15px] font-medium text-ink">
                  {t("secret.onlySentTo", { host: service.host })}
                </div>
              </div>
            )}
            {!provided && !declined && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-secondary/80">
                <LockKeyhole size={11} /> {t("secret.storedLocally")}
              </p>
            )}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          {!provided && !declined && (
            <button
              onClick={dismiss}
              aria-label={t("secret.notNow")}
              title={t("secret.notNow")}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={15} />
            </button>
          )}
        </div>
        {!provided && !declined && (
          <form onSubmit={(event) => void save(event)} className="border-t border-hairline/40 bg-panel/40 px-4 py-3">
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={secret.placeholder}
                disabled={saving || savedLocally}
                aria-label={secret.label}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={saving || (!value.trim() && !savedLocally)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />}
                {savedLocally ? t("secret.continueTask") : t("secret.saveSecurely")}
              </button>
            </div>
            {secret.helpUrl && (
              <a
                href={secret.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
              >
                {t("secret.whereToGet")} <ExternalLink size={11} />
              </a>
            )}
          </form>
        )}
        {(provided || declined) && (
          <div className={cn(
            "flex items-center justify-between border-t border-hairline/40 bg-panel/40 px-4 py-2.5 text-[11.5px]",
            declined ? "text-danger" : "text-success",
          )}>
            <span className="flex items-center gap-1.5">
              {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
              {footerLabel}
            </span>
            {!secret.resumed && error && (
              <button
                onClick={() => void retryResume()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {t("onboarding.tryAgain")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
