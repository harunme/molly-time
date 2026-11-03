import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName, fieldErrorMotionClassName } from "@/components/ui/motion";

function Input({ className, type, controlSize = "default", ...props }: React.ComponentProps<"input"> & { controlSize?: "default" | "compact" }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-control w-full min-w-0 rounded-[20px] bg-input-surface px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        controlSize === "compact" && "h-control-compact",
        controlMotionClassName,
        fieldErrorMotionClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
