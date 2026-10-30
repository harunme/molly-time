import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const toasterOffset = {
  top: "calc(var(--app-header-height) + 0.75rem)",
} as const;

const toasterStyle = { "--width": "var(--spacing-toast)" } as CSSProperties;

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-center"
      duration={3000}
      offset={toasterOffset}
      style={toasterStyle}
      toastOptions={{
        classNames: {
          toast: "ui-toast !min-h-control-lg !w-[var(--width)] !gap-2 !rounded-ui !border !border-toast-border !bg-foreground !px-3.5 !py-2.5 !text-white !shadow-toast will-change-[transform,opacity]",
          content: "!min-w-0 !gap-0.5",
          icon: "!m-0 !size-4 [&>svg]:!size-4",
          title: "!text-ui !leading-4.5 !font-medium",
          description:
            "!text-xs !leading-4 !text-white/75",
          success: "[&_[data-icon]]:!text-white",
          error:
            "!border-l-[0.1875rem] !border-l-toast-error-border [&_[data-icon]]:!text-toast-error-icon",
          warning:
            "!border-l-[0.1875rem] !border-l-primary [&_[data-icon]]:!text-primary-text",
          info: "!border-l-[0.1875rem] !border-l-toast-info-border [&_[data-icon]]:!text-toast-info-icon",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
export { toast } from "sonner";
