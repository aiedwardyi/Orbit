import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { Section } from "./SettingsPrimitives";

interface RemoteLink {
  url: string | null;
  setup?: {
    state: "checking" | "disabled" | "missing" | "not-running" | "serve-disabled" | "error" | "ready";
    enableUrl?: string;
  };
}

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RemoteLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const body: RemoteLink = await api("/api/remote-link");
        if (live) setStatus(body);
      } catch {
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);

  const url = status?.url;
  const setup = status?.setup;
  if (!url) {
    if (!setup || setup.state === "disabled") return null;
    const help = setup.state === "missing" ? "settings.phoneLink.missing"
      : setup.state === "not-running" ? "settings.phoneLink.notRunning"
      : setup.state === "serve-disabled" ? "settings.phoneLink.serveDisabled"
      : setup.state === "checking" ? "settings.phoneLink.checking"
      : "settings.phoneLink.error";
    return (
      <Section title={t("settings.phoneLink.title")} subtitle={t(help)}>
        {setup.state === "serve-disabled" && setup.enableUrl && (
          <a
            href={setup.enableUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70"
          >
            {t("settings.phoneLink.enableServe")}
          </a>
        )}
      </Section>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard permission can be denied; leave the button unchanged
    }
  };

  return (
    <Section title={t("settings.phoneLink.title")} subtitle={t("settings.phoneLink.help")}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-full truncate rounded-lg bg-inset px-3 py-2 font-mono text-[13px] text-ink sm:basis-0">
          {new URL(url).host}/••••••••
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          {copied ? t("settings.phoneLink.copied") : t("settings.phoneLink.copy")}
        </button>
      </div>
    </Section>
  );
}
