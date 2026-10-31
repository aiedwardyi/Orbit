import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  CREDENTIAL_BROKER,
  CREDENTIAL_TARGETS,
  customCredentialId,
  type BrokeredCredentialId,
  type CredentialId,
} from "../../shared/credential-request";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { credentialErrorMessage, saveCredential } from "@/lib/credentials";
import { cn } from "@/lib/cn";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { usePresence } from "@/lib/use-presence";
import { useBackLayer } from "@/lib/use-back-layer";
import { showEmptyKeysCard } from "@/lib/friends-chrome";
import { Section } from "./SettingsPrimitives";
import { ConfirmDialog } from "./ConfirmDialog";

export type ConfigSection = "composio" | "box";

const SECTIONS: Record<
  ConfigSection,
  { flag: (config: ConfigStatus) => boolean }
> = {
  composio: {
    flag: (c) => c.composio.configured,
  },
  box: { flag: (c) => c.box.configured },
};

const ELECTRON_CREDENTIAL: Record<ConfigSection, "composioApiKey" | "boxToken"> = {
  composio: "composioApiKey",
  box: "boxToken",
};

const CREDENTIALS: Record<
  ConfigSection,
  {
    label: MessageKey;
    placeholder: string | MessageKey;
    description: MessageKey;
    href: string;
    linkLabel: MessageKey;
    optional: boolean;
    warning?: MessageKey;
  }
> = {
  composio: {
    label: "connections.composio.label",
    placeholder: "ak_…",
    description: "connections.composio.description",
    href: "https://dashboard.composio.dev",
    linkLabel: "connections.composio.link",
    optional: true,
  },
  box: {
    label: "connections.box.label",
    placeholder: "connections.box.placeholder",
    description: "connections.box.description",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabel: "connections.box.link",
    optional: true,
    warning: "connections.box.warning",
  },
};

function CredentialHelp({ section }: { section: ConfigSection }) {
  const { t } = useI18n();
  const credential = CREDENTIALS[section];
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  useBackLayer(open, () => setOpen(false));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("connections.about", { label: t(credential.label) })}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none transition-colors hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {presence.mounted && (
        <div
          id={popoverId}
          data-closing={presence.closing || undefined}
          inert={presence.closing}
          role="group"
          aria-label={t("connections.helpAria", { label: t(credential.label) })}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{t(credential.description)}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{t(credential.warning)}</span>
            </div>
          )}
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {t(credential.linkLabel)}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

export function ApiKeyRow({
  section,
  onSaved,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const credential = CREDENTIALS[section];

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    const request = saveCredential(ELECTRON_CREDENTIAL[section], value.trim());
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(credentialErrorMessage(e, t)))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{t(credential.label)}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            {t("connections.optional")}
          </span>
        )}
        {configured && <span className="text-[11px] text-success">{t("connections.connected")}</span>}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? t("connections.pasteToReplace") : (credential.placeholder.startsWith("connections.") ? t(credential.placeholder as MessageKey) : credential.placeholder)}
          aria-label={t(credential.label)}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-danger text-danger-ink hover:brightness-110"
              : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? t("connections.removeKey") : t("settings.browserProfiles.save")}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? t("room.clear") : <><Check size={13} />{t("settings.browserProfiles.save")}</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ vps: { sshAlias: alias.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{t("connections.vps.label")}</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("connections.optional")}
        </span>
        {configured && <span className="text-[11px] text-success">{t("connections.connected")}</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">
        {t("connections.vps.help")}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("connections.vps.aliasAria")}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!alias.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            !alias.trim() && configured
              ? "bg-danger text-danger-ink hover:brightness-110"
              : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={!alias.trim() && configured ? t("connections.removeAlias") : t("settings.browserProfiles.save")}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && configured ? t("room.clear") : <><Check size={13} />{t("settings.browserProfiles.save")}</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

const BROKERED_CONFIGURED: Record<BrokeredCredentialId, (config: ConfigStatus) => boolean> = {
  openaiImageApiKey: (c) => c.imageGen?.configured ?? false,
  xaiApiKey: (c) => c.xai?.configured ?? false,
  geminiApiKey: (c) => c.gemini?.configured ?? false,
  ttsKey: (c) => c.tts?.configured ?? false,
  anthropicApiKey: (c) => c.anthropic?.configured ?? false,
  vertexApiKey: (c) => c.vertex?.configured ?? false,
};

export function relativeTimeLabel(at: string, locale: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(at) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** Saved keys bots can use through call_api. Values are never shown. */
export function SavedKeys() {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const [uses, setUses] = useState<Record<string, { botId: string; at: string }>>({});
  const [removing, setRemoving] = useState<{ id: CredentialId; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const config = state.config;
  const saved: { id: CredentialId; label: string }[] = [
    ...(Object.keys(CREDENTIAL_BROKER) as BrokeredCredentialId[])
      .filter((id) => config && BROKERED_CONFIGURED[id](config))
      .map((id) => ({ id, label: CREDENTIAL_TARGETS[id].label })),
    ...(config?.customKeys ?? []).map((k) => ({ id: customCredentialId(k.host), label: `${k.name} · ${k.host}` })),
  ];

  useEffect(() => {
    let live = true;
    api("/api/key-uses")
      .then((body: { uses?: typeof uses }) => live && setUses(body.uses ?? {}))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const remove = (id: CredentialId) => {
    setError(null);
    const request = saveCredential(id, "");
    request
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(credentialErrorMessage(e, t)));
  };

  if (saved.length === 0 && !showEmptyKeysCard()) return null;

  return (
    <Section title={t("keys.title")}>
      {saved.length === 0 && <div className="px-1 text-[12px] text-ink-secondary">{t("keys.empty")}</div>}
      {saved.map(({ id, label }) => {
        const use = uses[id];
        const bot = use && state.bots.find((b) => b.id === use.botId);
        return (
          <div key={id} className="flex min-h-[44px] items-center gap-2 rounded-lg px-1 hover:bg-raised/50">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-ink">{label}</div>
              <div className="truncate text-[11.5px] text-ink-secondary">
                {use
                  ? t("keys.lastUsed", { bot: bot?.name ?? use.botId, time: relativeTimeLabel(use.at, locale) })
                  : t("keys.notUsed")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRemoving({ id, label })}
              aria-label={t("connections.removeKey")}
              title={t("connections.removeKey")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-danger"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {removing && (
        <ConfirmDialog
          title={t("connections.removeKey")}
          body={t("keys.removeConfirm", { label: removing.label })}
          confirmLabel={t("connections.removeKey")}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            remove(removing.id);
          }}
        />
      )}
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </Section>
  );
}
