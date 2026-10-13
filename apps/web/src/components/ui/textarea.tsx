import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName, fieldErrorMotionClassName } from "@/components/ui/motion";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full resize-y rounded-ui border border-border bg-card px-3 py-2 text-base text-foreground outline-none placeholder:text-placeholder focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        controlMotionClassName,
        fieldErrorMotionClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
