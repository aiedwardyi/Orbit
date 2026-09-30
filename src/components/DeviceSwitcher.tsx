import { useEffect, useState } from "react";
import { Check, Monitor, Pencil } from "lucide-react";

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

const DEVICES_CHANGE = "orbit-devices-change";

function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<DeviceItem[]>([]);

  useEffect(() => {
    if (!enabled) return;
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
    window.addEventListener(DEVICES_CHANGE, load);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(DEVICES_CHANGE, load);
    };
  }, [enabled]);

  return devices;
}

/** Phones jump in place; the desktop app opens the PC in its own window. */
export function DeviceSwitcher({ navigate = (url) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const { t } = useI18n();
  const deviceWindow = window.ogb?.deviceWindow;
  const visible = Boolean(deviceWindow) || isPhone();
  const devices = useDevices(visible);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (devices.length < 2 || !visible) return null;

  const close = () => {
    setOpen(false);
    setRenaming(false);
  };
  const rename = (value: string) => {
    const name = value.trim();
    if (!name || name.length > 64) return;
    api("/api/devices/name", { method: "PUT", body: JSON.stringify({ name }) })
      .then(() => {
        window.dispatchEvent(new Event(DEVICES_CHANGE));
        setRenaming(false);
      })
      .catch(() => {});
  };

  return (
    <div data-device-switcher>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-label={t("chrome.devices")}
        className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        title={t("chrome.devices")}
      >
        <Monitor size={20} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={close} />
          <ul className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
            {devices.map((device) =>
              device.current && renaming ? (
                <li key={device.deviceId} className="px-2.5 py-1">
                  <input
                    autoFocus
                    defaultValue={device.name}
                    maxLength={64}
                    aria-label={t("chrome.renameDevice")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") rename(event.currentTarget.value);
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenaming(false);
                      }
                    }}
                    className="w-full rounded-md border border-hairline bg-raised px-2 py-1.5 text-[14px] text-ink outline-none focus:border-accent"
                  />
                </li>
              ) : (
                <li key={device.deviceId} className="flex items-center">
                  <button
                    type="button"
                    data-device-id={device.deviceId}
                    onClick={() => {
                      if (device.current) return close();
                      if (!deviceWindow) return navigate(`https://${device.host}/`);
                      void deviceWindow.open(device.host, device.name).catch(() => {});
                      close();
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-3 py-2 pl-3.5 text-left text-[14px] text-ink hover:bg-raised/70",
                      device.current ? "pr-2" : "pr-3.5",
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
                  {device.current && (
                    <button
                      type="button"
                      onClick={() => setRenaming(true)}
                      aria-label={t("chrome.renameDevice")}
                      title={t("chrome.renameDevice")}
                      className="mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </li>
              ),
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/** Which PC this is, everywhere but the local desktop app window. */
export function DeviceTag() {
  const local = Boolean(window.ogb);
  const devices = useDevices(!local);
  const name = devices.length > 1 ? devices.find((device) => device.current)?.name : undefined;
  if (local || !name) return null;
  return (
    <span
      data-device-tag
      title={name}
      className="min-w-0 truncate rounded-md border border-hairline/60 px-1.5 py-0.5 text-[11px] leading-none text-ink-secondary"
    >
      {name}
    </span>
  );
}
