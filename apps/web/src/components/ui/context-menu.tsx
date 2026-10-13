import * as React from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { controlMotionClassName } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

function ContextMenu({
  ariaLabel,
  children,
  contentTestId,
  onOpenChange,
  open,
  position,
}: {
  ariaLabel: string;
  children: React.ReactNode;
  contentTestId?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  position: ContextMenuPosition;
}) {
  const rootFontSize = readRootFontSize();
  const anchorStyle = {
    "--context-menu-x": `${position.x / rootFontSize}rem`,
    "--context-menu-y": `${position.y / rootFontSize}rem`,
  } as React.CSSProperties;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed top-[var(--context-menu-y)] left-[var(--context-menu-x)] size-0"
          style={anchorStyle}
        />
      </PopoverAnchor>
      <PopoverContent
        data-testid={contentTestId}
        role="menu"
        aria-label={ariaLabel}
        align="start"
        side="bottom"
        sideOffset={0}
        collisionPadding={8}
        className="w-auto min-w-45 p-1"
        onKeyDown={handleMenuKeyDown}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function ContextMenuItem({
  children,
  className,
  disabled,
  onSelect,
  variant = "default",
  ...props
}: Omit<React.ComponentProps<"button">, "onClick"> & {
  onSelect: () => void;
  variant?: "default" | "destructive";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-ui px-3 py-2.25 text-left text-ui leading-4 text-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4",
        controlMotionClassName,
        variant === "destructive" &&
        "text-destructive hover:bg-destructive-surface focus-visible:bg-destructive-surface",
        className,
      )}
      disabled={disabled}
      onClick={onSelect}
      {...props}
    >
      {children}
    </button>
  );
}

function ContextMenuSeparator({ className }: { className?: string; }) {
  return (
    <div
      role="separator"
      className={cn("my-1 h-0.25 bg-border", className)}
    />
  );
}

function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    ),
  );
  if (!items.length) return;
  event.preventDefault();
  const activeIndex = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Home") {
    items[0].focus();
    return;
  }
  if (event.key === "End") {
    items[items.length - 1]?.focus();
    return;
  }
  const offset = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex =
    activeIndex < 0
      ? offset > 0
        ? 0
        : items.length - 1
      : (activeIndex + offset + items.length) % items.length;
  items[nextIndex].focus();
}

function readRootFontSize(): number {
  if (typeof window === "undefined") return 16;
  const value = Number.parseFloat(
    window.getComputedStyle(window.document.documentElement).fontSize,
  );
  return Number.isFinite(value) && value > 0 ? value : 16;
}

export { ContextMenu, ContextMenuItem, ContextMenuSeparator };
