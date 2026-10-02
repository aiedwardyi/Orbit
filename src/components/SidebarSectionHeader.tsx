import { useRef, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

export function SidebarSectionHeader({
  name,
  reorderable,
  dragging,
  collapsed = false,
  hiddenCount = 0,
  unreadBadge = null,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMove,
}: {
  name: string;
  reorderable: boolean;
  dragging: boolean;
  collapsed?: boolean;
  hiddenCount?: number;
  unreadBadge?: string | null;
  onToggle?: () => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onMove?: (direction: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const dragged = useRef(false);
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorderable || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove?.(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove?.(1);
    }
  };
  const label = !collapsed
    ? name
    : unreadBadge != null
      ? t("chrome.sectionCollapsedUnread", { name, count: hiddenCount, unread: unreadBadge })
      : t("chrome.sectionCollapsed", { name, count: hiddenCount });
  const content = (
    <>
      {onToggle && (
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
            collapsed && "-rotate-90",
          )}
        />
      )}
      <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {name}
      </span>
      {collapsed && hiddenCount > 0 && (
        <span data-sidebar-section-count className="shrink-0 text-[10px] font-medium tabular-nums text-ink-secondary">
          · {hiddenCount}
        </span>
      )}
      {collapsed && unreadBadge != null && (
        <span
          data-sidebar-section-unread
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink"
        >
          {unreadBadge}
        </span>
      )}
      <span className="h-px flex-1 bg-hairline/40" />
    </>
  );
  // A drag that ends over its own button may still click it.
  const onClick = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onToggle?.();
  };

  return (
    <div
      className="flex min-w-0 items-center gap-1 px-2 pb-1 pt-3 first:pt-0"
      data-section={name}
      data-sidebar-section-header
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {reorderable ? (
        <button
          type="button"
          data-sidebar-section-handle
          aria-label={label}
          aria-expanded={onToggle ? !collapsed : undefined}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          draggable
          onPointerDown={() => { dragged.current = false; }}
          onClick={onClick}
          onDragStart={(event) => {
            dragged.current = true;
            onDragStart?.(event);
          }}
          onDragEnd={onDragEnd}
          onKeyDown={onHeaderKeyDown}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-raised/50",
            dragging && "opacity-40",
          )}
          title="Alt+Up/Down to reorder"
        >
          {content}
        </button>
      ) : onToggle ? (
        <button
          type="button"
          data-sidebar-section-toggle
          aria-label={label}
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
          {content}
        </div>
      )}
    </div>
  );
}
