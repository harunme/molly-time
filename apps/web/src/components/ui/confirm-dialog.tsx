import { LoaderCircle } from "lucide-react";
import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel = "确定", cancelLabel = "取消", destructive = false, onConfirm, testIdPrefix }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  testIdPrefix?: string;
}) {
  const [pending, setPending] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const confirm = async (event: React.MouseEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller owns error reporting; keep the dialog open so the action can be retried.
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <AlertDialogContent
        data-testid={testIdPrefix ? `${testIdPrefix}-dialog` : undefined}
        closeButtonTestId={testIdPrefix ? `${testIdPrefix}-close-button` : undefined}
        closeButtonDisabled={pending}
        onOpenAutoFocus={() => {
          if (document.activeElement instanceof HTMLElement) {
            triggerRef.current = document.activeElement;
          }
        }}
        onCloseAutoFocus={(event) => {
          if (!triggerRef.current?.isConnected) return;
          event.preventDefault();
          triggerRef.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        {description || children ? (
          <AlertDialogBody>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
            {children}
          </AlertDialogBody>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              data-testid={testIdPrefix ? `${testIdPrefix}-cancel-button` : undefined}
              className="min-w-22"
              variant="bordered"
              size="sm"
              disabled={pending}
            >
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              data-testid={testIdPrefix ? `${testIdPrefix}-confirm-button` : undefined}
              className="min-w-22"
              variant={destructive ? "destructive" : "default"}
              size="sm"
              disabled={pending}
              onClick={confirm}
            >
              {pending && <LoaderCircle className="animate-spin" />}
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDialog };
