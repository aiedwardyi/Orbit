import { useEffect, useState } from "react";
import { Check, Monitor } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";

export interface DeviceItem {
  deviceId: string;
  name: string;
  host: string;
  current: boolean;
  offline: boolean;
}

export function DeviceSwitcher({ navigate = (url) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const { t } = useI18n();
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isPhone()) return;
    let live = true;
    const load = () =>
      api("/api/devices")
        .then((body: { devices: DeviceItem[] }) => {
          if (live) setDevices(body.devices);
        })
        .catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (devices.length < 2 || !isPhone()) return null;

  return (
    <div data-device-switcher>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t("chrome.devices")}
        className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        title={t("chrome.devices")}
      >
        <Monitor size={20} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <ul className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
            {devices.map((device) => (
              <li key={device.deviceId}>
                <button
                  type="button"
                  data-device-id={device.deviceId}
                  onClick={() => (device.current ? setOpen(false) : navigate(`https://${device.host}/`))}
                  className={cn(
                    "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70",
                    device.offline && !device.current && "opacity-50",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{device.name}</span>
                  {device.current ? (
                    <span className="flex items-center gap-1 text-[12px] text-accent">
                      <Check size={14} />
                      {t("chrome.deviceCurrent")}
                    </span>
                  ) : device.offline ? (
                    <span className="text-[12px] text-ink-secondary">{t("chrome.deviceOffline")}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
