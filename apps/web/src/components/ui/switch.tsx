import { Switch as SwitchPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName } from "@/components/ui/motion";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "default" | "sm";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full bg-switch-track outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground",
        size === "sm"
          ? "h-4 w-7"
          : "h-5 w-9",
        controlMotionClassName,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block translate-x-0.5 transition-transform duration-[var(--motion-duration-slow)] ease-[var(--motion-ease-switch-spring)] will-change-transform motion-reduce:transition-none",
          size === "sm"
            ? "h-3 w-3 data-[state=checked]:translate-x-3.5"
            : "h-4 w-4 data-[state=checked]:translate-x-4.5",
        )}
      >
        <span
          data-slot="switch-thumb-face"
          className="block size-full origin-left rounded-full bg-card shadow-thumb transition-transform duration-[var(--motion-duration-quick)] ease-[var(--motion-ease-standard)] group-active/switch:scale-x-[1.18] group-active/switch:scale-y-[0.9] group-data-[state=checked]/switch:origin-right motion-reduce:transition-none motion-reduce:group-active/switch:scale-100"
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
