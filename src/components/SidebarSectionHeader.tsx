import { GripVertical } from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

export function SidebarSectionHeader({
  name,
  reorderable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMove,
}: {
  name: string;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onMove?: (direction: -1 | 1) => void;
}) {
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
          aria-label={name}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onKeyDown={onHeaderKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
          title="Alt+Up/Down to reorder"
        >
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          <span className="h-px flex-1 bg-hairline/40" />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          <span className="h-px flex-1 bg-hairline/40" />
        </div>
      )}
      {reorderable && (
        <span
          aria-hidden="true"
          draggable
          data-sidebar-section-grip
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={cn(
            "flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink",
            dragging && "opacity-40",
          )}
          title="Drag to reorder"
        >
          <GripVertical size={13} />
        </span>
      )}
    </div>
  );
}
