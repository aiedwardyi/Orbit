import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { Section } from "./SettingsPrimitives";

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api("/api/remote-link")
      .then((body: { url: string | null }) => {
        if (live) setUrl(body.url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!url) return null;

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
