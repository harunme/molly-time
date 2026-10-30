import { Dialog as SheetPrimitive } from "radix-ui";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;
function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return <SheetPrimitive.Overlay data-slot="sheet-overlay" className={cn("fixed inset-0 z-(--z-overlay) bg-alert-overlay data-[state=open]:animate-[ui-overlay-in_var(--motion-duration-fast)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-overlay-out_var(--motion-duration-quick)_var(--motion-ease-standard)_forwards] motion-reduce:animate-none", className)} {...props} />;
}
function SheetContent({ side = "right", className, children, closeButtonTestId, ...props }: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: "top" | "right" | "bottom" | "left"; closeButtonTestId?: string; }) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-(--z-dialog) flex bg-card shadow-alert-dialog outline-none data-[state=open]:duration-[var(--motion-duration-slow)] data-[state=closed]:duration-[var(--motion-duration-medium)] motion-reduce:animate-none",
          side === "right" && "inset-y-0 right-0 h-full w-110 max-w-[92vw] flex-col data-[state=open]:animate-[ui-sheet-right-in_var(--motion-duration-slow)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-sheet-right-out_var(--motion-duration-medium)_var(--motion-ease-standard)_forwards]",
          side === "left" && "inset-y-0 left-0 h-full w-110 max-w-[92vw] flex-col data-[state=open]:animate-[ui-sheet-left-in_var(--motion-duration-slow)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-sheet-left-out_var(--motion-duration-medium)_var(--motion-ease-standard)_forwards]",
          side === "top" && "inset-x-0 top-0 flex-col data-[state=open]:animate-[ui-sheet-top-in_var(--motion-duration-slow)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-sheet-top-out_var(--motion-duration-medium)_var(--motion-ease-standard)_forwards]",
          side === "bottom" && "inset-x-0 bottom-0 flex-col data-[state=open]:animate-[ui-sheet-bottom-in_var(--motion-duration-slow)_var(--motion-ease-standard)] data-[state=closed]:animate-[ui-sheet-bottom-out_var(--motion-duration-medium)_var(--motion-ease-standard)_forwards]",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close data-slot="button" data-testid={closeButtonTestId} className="absolute top-3 right-3 grid h-control-sm w-control-sm place-items-center rounded-ui text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          <X className="h-5.5 w-5.5" /><span className="sr-only">关闭</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 flex-col px-5 py-4.5 pr-14", className)} {...props} />;
}
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-auto flex gap-2 p-5", className)} {...props} />;
}
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn("text-lg font-semibold leading-[normal] text-foreground", className)} {...props} />;
}
function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn("mt-0.5 truncate text-sm leading-[normal] text-muted-foreground", className)} {...props} />;
}
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-auto p-5", className)} {...props} />;
}

export { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetOverlay, SheetPortal, SheetTitle, SheetTrigger };
