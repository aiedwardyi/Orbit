import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Laptop, Monitor, Pencil } from "lucide-react";

import { leaveFor } from "@/lib/back-navigation";
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
  laptop?: boolean;
}

const DeviceIcon = ({ device, size, className }: { device: DeviceItem; size: number; className?: string }) =>
  device.laptop ? <Laptop size={size} className={cn("shrink-0", className)} /> : <Monitor size={size} className={cn("shrink-0", className)} />;

const DEVICES_CHANGE = "orbit-devices-change";

function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const live = useRef(true);
  const load = useCallback(
    () =>
      api("/api/devices")
        .then((body: { devices: DeviceItem[] }) => {
          if (live.current) setDevices(body.devices);
        })
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    live.current = true;
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(DEVICES_CHANGE, load);
    return () => {
      live.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(DEVICES_CHANGE, load);
    };
  }, [enabled, load]);

  return [devices, load] as const;
}

type Navigate = (url: string) => void;

/** Phones jump in place from the chat header, leaving no Back step to this PC; the desktop app opens the PC in its own window. */
export function DeviceSwitcher({
  navigate = leaveFor,
  compact = false,
}: {
  navigate?: Navigate;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const deviceWindow = window.ogb?.deviceWindow;
  const visible = compact || Boolean(deviceWindow);
  const [devices, reload] = useDevices(visible);
  const [open, setOpen] = useState(false);
  // The chat header clips overflow, so the phone menu is pinned to the viewport.
  const [pinned, setPinned] = useState<CSSProperties>();
  const [renaming, setRenaming] = useState(false);

  const here = devices.find((device) => device.current);
  if (devices.length < 2 || !visible || (compact && !here)) return null;

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
    <div data-device-switcher className={cn(compact && "mr-2 shrink-0")}>
      <button
        type="button"
        data-device-tag={compact ? "" : undefined}
        onClick={(event) => {
          if (open) return close();
          if (compact) {
            const rect = event.currentTarget.getBoundingClientRect();
            setPinned({ top: rect.bottom, left: rect.left });
          }
          setOpen(true);
          reload();
        }}
        aria-expanded={open}
        aria-label={t("chrome.devices")}
        className={cn(
          "flex items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
          compact ? "size-[30px]" : "size-10",
        )}
        title={compact ? here!.name : t("chrome.devices")}
      >
        {here ? <DeviceIcon device={here} size={compact ? 18 : 20} /> : <Monitor size={20} />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={close} />
          <ul
            className={cn(
              "z-40 mt-1 w-60 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
              compact ? "fixed" : "absolute right-0 top-full",
            )}
            style={compact ? pinned : undefined}
          >
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
                    <span className="text-ink-secondary">
                      <DeviceIcon device={device} size={16} />
                    </span>
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

/** Which PC this is, everywhere but the local desktop app window. On phones it opens the PC menu. */
export function DeviceTag({ navigate }: { navigate?: Navigate }) {
  const local = Boolean(window.ogb);
  const phone = isPhone();
  const [devices] = useDevices(!local && !phone);
  const device = devices.length > 1 ? devices.find((item) => item.current) : undefined;
  if (!local && phone) return <DeviceSwitcher compact navigate={navigate} />;
  if (local || !device) return null;
  return (
    <span
      data-device-tag
      title={device.name}
      className="flex min-w-0 items-center gap-1 text-[12px] leading-none text-ink-secondary"
    >
      <DeviceIcon device={device} size={14} />
      <span className="truncate">{device.name}</span>
    </span>
  );
}
