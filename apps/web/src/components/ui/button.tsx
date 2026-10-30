import { Slot as SlotPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { pressMotionClassName } from "@/components/ui/motion";

const Slot = SlotPrimitive.Root;

const buttonVariants = cva(
  `inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 ${pressMotionClassName}`,
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-primary font-semibold text-primary-foreground hover:bg-primary-hover",
        destructive:
          "border border-destructive bg-destructive text-white hover:bg-destructive-hover",
        bordered:
          "border border-border bg-card text-foreground hover:border-primary hover:bg-card hover:shadow-primary-inset",
        secondary:
          "border border-transparent bg-border text-foreground hover:bg-border-strong",
        ghost:
          "border border-transparent bg-transparent text-foreground hover:bg-muted",
        link: "h-auto bg-transparent px-1 text-primary-text underline-offset-[0.25rem] hover:underline",
      },
      size: {
        default: "h-control min-w-button px-4 text-ui",
        sm: "h-control-sm px-3 text-sm",
        lg: "h-control-lg px-6 text-ui",
        icon: "h-control-sm w-control-sm min-w-0 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

type StatefulButtonProps = Omit<ButtonProps, "asChild" | "children"> & {
  state?: "idle" | "loading" | "success" | "error";
  children: React.ReactNode;
  loadingLabel?: React.ReactNode;
  successLabel?: React.ReactNode;
  errorLabel?: React.ReactNode;
};

function StatefulButton({
  state = "idle",
  children,
  loadingLabel = "处理中",
  successLabel = "已完成",
  errorLabel = "操作失败",
  className,
  variant,
  disabled,
  ...props
}: StatefulButtonProps) {
  const content = {
    idle: { icon: null, label: children },
    loading: { icon: <LoaderCircle className="animate-spin motion-reduce:animate-none" />, label: loadingLabel },
    success: { icon: <Check />, label: successLabel },
    error: { icon: <CircleAlert />, label: errorLabel },
  }[state];

  return (
    <Button
      data-state={state}
      aria-busy={state === "loading" || undefined}
      className={cn(state === "loading" && "disabled:opacity-100", className)}
      variant={variant ?? (state === "error" ? "destructive" : undefined)}
      disabled={disabled || state === "loading"}
      {...props}
    >
      <span
        key={state}
        aria-live="polite"
        className="inline-flex items-center justify-center gap-2 animate-[ui-action-swap-in_var(--motion-duration-fast)_var(--motion-ease-standard)] motion-reduce:animate-none"
      >
        {content.icon}
        {content.label}
      </span>
    </Button>
  );
}

export { Button, StatefulButton, buttonVariants };
export type { ButtonProps, StatefulButtonProps };
