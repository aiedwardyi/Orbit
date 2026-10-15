import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, Laptop, Monitor, Pencil } from "lucide-react";

import { leaveFor } from "@/lib/back-navigation";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { cn } from "@/lib/cn";
import { usePresence } from "@/lib/use-presence";
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

/** Phones jump in place from the bot list, leaving no Back step to this PC; the desktop app opens the PC in its own window. */
export function DeviceSwitcher({
  navigate = leaveFor,
  labeled = false,
  iconOnly = false,
  drawerOpen,
}: {
  navigate?: Navigate;
  /** Phone drawer: current PC's icon and name. The menu is portaled so the drawer cannot clip it. */
  labeled?: boolean;
  /** Phone icon rail: with `labeled`, the icon alone as a 40 px button. */
  iconOnly?: boolean;
  /** Phone drawer state: the portaled menu shuts with it. */
  drawerOpen?: boolean;
}) {
  const { t } = useI18n();
  const deviceWindow = window.ogb?.deviceWindow;
  const visible = labeled || Boolean(deviceWindow);
  const [devices, reload] = useDevices(visible);
  const [open, setOpen] = useState(false);
  // The drawer is transformed, so a phone menu pinned inside it would clip. Portal it instead.
  const [pinned, setPinned] = useState<CSSProperties>();
  const [renaming, setRenaming] = useState(false);
  const presence = usePresence(open);
  // The menu lives on the body, so the drawer sliding shut would strand it over the chat.
  useEffect(() => {
    if (labeled && drawerOpen === false) {
      setOpen(false);
      setRenaming(false);
    }
  }, [labeled, drawerOpen]);

  const here = devices.find((device) => device.current);
  const tip = iconOnly && here ? `${t("chrome.devices")}: ${here.name}` : undefined;
  if (devices.length < 2 || !visible || (labeled && !here)) return null;

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

  const menu = presence.mounted && (
    <>
      {!presence.closing && <div className={cn("fixed inset-0", labeled ? "z-50" : "z-30")} onMouseDown={close} />}
      <ul
        data-closing={presence.closing || undefined}
        inert={presence.closing}
        className={cn(
          "animate-pop-in mt-1 w-60 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
          labeled ? "fixed z-50" : "absolute right-0 top-full z-40",
        )}
        style={pinned}
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
  );

  return (
    <div data-device-switcher className={cn(labeled && "min-w-0 max-w-full")}>
      <button
        type="button"
        data-device-tag={labeled ? "" : undefined}
        onClick={(event) => {
          if (open) return close();
          const menuWidth = 240;
          if (labeled) {
            const rect = event.currentTarget.getBoundingClientRect();
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
            setPinned({ top: rect.bottom, left });
          } else {
            // The menu hangs off the button row's right edge; a narrow sidebar would push it off screen.
            const row = (event.currentTarget.offsetParent ?? event.currentTarget).getBoundingClientRect();
            const aside = event.currentTarget.closest("aside")?.getBoundingClientRect();
            const [min, max] = aside && aside.width >= menuWidth + 16 ? [aside.left + 8, aside.right - 8] : [8, window.innerWidth - 8];
            setPinned({ right: row.right - Math.min(Math.max(row.right, min + menuWidth), max) });
          }
          setOpen(true);
          reload();
        }}
        aria-expanded={open}
        aria-label={tip ?? t("chrome.devices")}
        className={cn(
          "flex items-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
          labeled && !iconOnly ? "min-w-0 max-w-full justify-start gap-1.5 py-1 pl-0.5 pr-1.5 text-[13px] leading-none" : "size-10 justify-center",
        )}
        title={tip ?? (labeled && here ? here.name : t("chrome.devices"))}
      >
        {here ? <DeviceIcon device={here} size={labeled && !iconOnly ? 18 : 20} /> : <Monitor size={20} />}
        {labeled && !iconOnly && here && <span className="truncate">{here.name}</span>}
      </button>
      {labeled && menu ? createPortal(menu, document.body) : menu}
    </div>
  );
}

/** Which PC this is in a desktop browser. Phones keep the picker in the bot list. */
export function DeviceTag(_props?: { navigate?: Navigate }) {
  const local = Boolean(window.ogb);
  const phone = isPhone();
  const [devices] = useDevices(!local && !phone);
  const device = devices.length > 1 ? devices.find((item) => item.current) : undefined;
  if (local || phone || !device) return null;
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
