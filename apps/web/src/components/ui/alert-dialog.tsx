import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { dialogMotionClassName, overlayMotionClassName } from "@/components/ui/motion";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogPortal = AlertDialogPrimitive.Portal;
const AlertDialogCancel = AlertDialogPrimitive.Cancel;

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return <AlertDialogPrimitive.Overlay data-slot="alert-dialog-overlay" className={cn("fixed inset-0 z-(--z-alert-overlay) bg-dialog-overlay backdrop-blur-dialog", overlayMotionClassName, className)} {...props} />;
}
function AlertDialogContent({
  className,
  children,
  showCloseButton = true,
  closeButtonTestId,
  closeButtonDisabled = false,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  showCloseButton?: boolean;
  closeButtonTestId?: string;
  closeButtonDisabled?: boolean;
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-(--z-alert-dialog) grid max-h-[90vh] w-[calc(100%-2rem)] max-w-112 -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-dialog bg-card shadow-dialog outline-none",
          dialogMotionClassName,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <AlertDialogPrimitive.Cancel
            data-slot="button"
            data-testid={closeButtonTestId}
            disabled={closeButtonDisabled}
            className="absolute top-3.5 right-3.5 grid h-6 w-6 place-items-center rounded-full text-icon-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">关闭</span>
          </AlertDialogPrimitive.Cancel>
        )}
      </AlertDialogPrimitive.Content>
    </AlertDialogPortal>
  );
}
function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-1.5 px-5 pt-5 pr-13 pb-1", className)} {...props} />;
}
function AlertDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-body" className={cn("min-w-0 overflow-y-auto px-5 py-3", className)} {...props} />;
}
function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-footer" className={cn("flex justify-end gap-2 px-5 pt-1 pb-5", className)} {...props} />;
}
function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("text-lg font-semibold text-foreground", className)} {...props} />;
}
function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("text-sm leading-[1.4] text-muted-foreground", className)} {...props} />;
}
function AlertDialogAction(props: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return <AlertDialogPrimitive.Action {...props} />;
}

export { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPortal, AlertDialogTitle, AlertDialogTrigger };
