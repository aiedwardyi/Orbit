import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useI18n } from "@/lib/i18n";
import { remotePhoneSetup, type RemotePhoneLink } from "@/lib/phone-setup";
import { api } from "@/state/store";
import { PhoneAccessSettings } from "./PhoneAccessSettings";

const DOWNLOAD = "https://tailscale.com/download";
const button = "inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70";

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RemotePhoneLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const body: RemotePhoneLink = await api("/api/remote-link");
        if (live) setStatus(body);
      } catch {
        if (live) setStatus({ url: null, setup: { state: "error" } });
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void load(), 15_000);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    void load();
    return () => {
      live = false;
      window.clearInterval(timer);
      window.clearTimeout(copiedTimer.current);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const setup = remotePhoneSetup(status);
  const copy = async () => {
    if (!setup.url) return;
    try {
      await navigator.clipboard.writeText(setup.url);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <div data-phone-settings className="rounded-xl bg-card p-4">
      <p className="break-keep text-[13px] leading-relaxed text-ink-secondary">{t("settings.phone.intro")}</p>
      <ol className="mt-5 flex flex-col gap-5">
        <li data-phone-step="1" data-complete={setup.running} className="flex items-start gap-3">
          <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] ${setup.running ? "bg-success/15 text-success" : "bg-control text-ink"}`}>
            {setup.running ? <Check size={15} aria-label={t("settings.phone.pcReady")} /> : "1"}
          </span>
          <div className="min-w-0">
            <h3 className="pt-0.5 text-[13px] font-medium text-ink">{t("settings.phone.step1")}</h3>
            {setup.state === "missing" && <a
              href={DOWNLOAD}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (window.ogb?.openExternal) {
                  event.preventDefault();
                  void window.ogb.openExternal(DOWNLOAD).catch(() => {});
                }
              }}
              className={`${button} mt-2`}
            >{t("settings.phone.getTailscale")}</a>}
          </div>
        </li>
        <li data-phone-step="2" className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-control text-[13px] text-ink">2</span>
          <h3 className="pt-0.5 text-[13px] font-medium text-ink">{t("settings.phone.step2")}</h3>
        </li>
        <li data-phone-step="3" className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-control text-[13px] text-ink">3</span>
          <div className="min-w-0">
            <h3 className="pt-0.5 text-[13px] font-medium text-ink">{t("settings.phone.step3")}</h3>
            {setup.url ? <>
              <div data-phone-link-qr className="mt-3 w-fit rounded-xl bg-white p-3" aria-label={t("settings.phoneAccess.qrLabel")}>
                <QRCodeSVG value={setup.url} size={168} level="M" bgColor="#ffffff" fgColor="#111111" />
              </div>
              <button type="button" onClick={() => void copy()} className={`${button} mt-3`}>
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                {copied ? t("settings.phoneLink.copied") : t("settings.phoneLink.copy")}
              </button>
            </> : <>
              <p className="mt-2 text-[12px] text-ink-secondary">{t(setup.help)}</p>
              {setup.state === "serve-disabled" && status?.setup?.enableUrl && <a href={status.setup.enableUrl} target="_blank" rel="noreferrer" className={`${button} mt-2`}>
                {t("settings.phoneLink.enableServe")}
              </a>}
            </>}
          </div>
        </li>
      </ol>
      <button type="button" aria-expanded={relayOpen} aria-controls="phone-relay-settings" onClick={() => setRelayOpen((open) => !open)} className="mt-5 text-[12px] text-ink-secondary underline hover:text-ink">
        {t("settings.phone.relay")}
      </button>
      <div id="phone-relay-settings" hidden={!relayOpen} className="mt-4 border-t border-hairline/40 pt-4">{relayOpen && <PhoneAccessSettings />}</div>
    </div>
  );
}
