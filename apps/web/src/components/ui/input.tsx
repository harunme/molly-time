import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName, fieldErrorMotionClassName } from "@/components/ui/motion";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-control w-full min-w-0 rounded-[20px] border border-border bg-card px-3 text-base text-foreground outline-none placeholder:text-placeholder focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        controlMotionClassName,
        fieldErrorMotionClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
