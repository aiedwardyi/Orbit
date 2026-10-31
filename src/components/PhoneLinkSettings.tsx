import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useI18n, type Translate } from "@/lib/i18n";
import { remotePhoneSetup, type RemotePhoneLink } from "@/lib/phone-setup";
import { api } from "@/state/store";
import { PhoneAccessSettings } from "./PhoneAccessSettings";

const DOWNLOAD = "https://tailscale.com/download";
const button = "inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-control/70";

function activeText(lastSeen: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - lastSeen) / 60000);
  if (minutes < 2) return t("settings.phone.activeNow");
  if (minutes < 60) return t("settings.phone.activeMinutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("settings.phone.activeHours", { n: hours });
  return t("settings.phone.activeDays", { n: Math.floor(hours / 24) });
}

function StepMark({ done, step, label }: { done: boolean; step: number; label: string }) {
  return (
    <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] ${done ? "bg-success/15 text-success" : "bg-control text-ink"}`}>
      {done ? <Check size={15} aria-label={label} /> : step}
    </span>
  );
}

export function PhoneLinkSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RemotePhoneLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [relayManaged, setRelayManaged] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const relayBox = useRef<HTMLDivElement>(null);

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

  // Relay setup is PC-only: a device window viewing this PC is refused, so it gets no link.
  useEffect(() => {
    let live = true;
    api("/api/phone-relay/status").then(() => live && setRelayManaged(true), () => {});
    return () => {
      live = false;
    };
  }, []);

  // The form renders once its status loads, so wait for it before scrolling.
  useEffect(() => {
    const box = relayBox.current;
    if (!relayOpen || !box) return;
    const reveal = () => {
      if (!box.firstElementChild) return false;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      box.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      box.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
      return true;
    };
    if (reveal()) return;
    const watch = new MutationObserver(() => {
      if (reveal()) watch.disconnect();
    });
    watch.observe(box, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [relayOpen]);

  const setup = remotePhoneSetup(status);
  const phones = status?.phones ?? [];
  const linked = phones.length > 0;
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
      {linked && <ul data-phone-list className="mb-4 flex flex-col gap-1.5">
        {phones.map((phone) => <li key={phone.id} className="text-[13px] text-ink">
          {t(`settings.phone.kind.${phone.kind}`)}<span className="text-ink-secondary"> · {activeText(phone.lastSeen, Date.now(), t)}</span>
        </li>)}
      </ul>}
      <p className="break-keep text-[13px] leading-relaxed text-ink-secondary">{t("settings.phone.intro")}</p>
      <ol className="mt-5 flex flex-col gap-5">
        <li data-phone-step="1" data-complete={setup.running} className="flex items-start gap-3">
          <StepMark done={setup.running} step={1} label={t("settings.phone.pcReady")} />
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
        <li data-phone-step="2" data-complete={linked} className="flex items-start gap-3">
          <StepMark done={linked} step={2} label={t("settings.phone.phoneReady")} />
          <h3 className="pt-0.5 text-[13px] font-medium text-ink">{t("settings.phone.step2")}</h3>
        </li>
        <li data-phone-step="3" data-complete={linked} className="flex items-start gap-3">
          <StepMark done={linked} step={3} label={t("settings.phone.phoneReady")} />
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
      {relayManaged && <>
        <button type="button" aria-expanded={relayOpen} aria-controls="phone-relay-settings" onClick={() => setRelayOpen((open) => !open)} className="mt-5 text-[12px] text-ink-secondary underline hover:text-ink">
          {t("settings.phone.relay")}
        </button>
        <div ref={relayBox} id="phone-relay-settings" hidden={!relayOpen} className="mt-4 border-t border-hairline/40 pt-4">{relayOpen && <PhoneAccessSettings />}</div>
      </>}
    </div>
  );
}
