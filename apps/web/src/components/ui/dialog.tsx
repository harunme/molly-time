import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dialogMotionClassName, overlayMotionClassName } from "@/components/ui/motion";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn("fixed inset-0 z-(--z-overlay) bg-dialog-overlay backdrop-blur-dialog", overlayMotionClassName, className)} {...props} />;
}
function DialogContent({ className, children, showCloseButton = true, closeButtonTestId, closeButtonClassName, overlayClassName, ...props }: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean; closeButtonTestId?: string; closeButtonClassName?: string; overlayClassName?: string; }) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn("fixed top-1/2 left-1/2 z-(--z-dialog) grid max-h-[90vh] w-[calc(100%-2rem)] max-w-130 -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-dialog border-0 bg-card shadow-dialog outline-none", dialogMotionClassName, className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button type="button" variant="ghost" size="icon" data-testid={closeButtonTestId} className={cn("absolute top-4.5 right-4.5 h-7 w-7 text-icon-muted hover:bg-surface-hover hover:text-foreground", closeButtonClassName)}>
              <X className="h-4 w-4" />
              <span className="sr-only">关闭</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 px-6 pt-6 pr-15 pb-2", className)} {...props} />;
}
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex justify-end gap-2 px-6 pt-2 pb-6", className)} {...props} />;
}
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-lg font-semibold text-foreground", className)} {...props} />;
}
function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" className={cn("px-6 py-4", className)} {...props} />;
}

export { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger };
