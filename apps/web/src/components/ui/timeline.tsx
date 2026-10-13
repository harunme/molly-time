import * as React from "react";
import { cn } from "@/lib/utils";

function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="timeline"
      className={cn("m-0 flex list-none flex-col gap-0 p-0", className)}
      {...props}
    />
  );
}

function TimelineItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="timeline-item"
      className={cn(
        "relative grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-sm after:absolute after:top-3 after:bottom-[-0.5625rem] after:left-1.5 after:w-0.25 after:bg-highlight after:content-[''] last:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function TimelineMarker({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="timeline-marker"
      aria-hidden="true"
      className={cn(
        "z-[1] mt-0.75 h-3 w-3 rounded-full bg-primary",
        className,
      )}
      {...props}
    />
  );
}

function TimelineContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="timeline-content"
      className={cn("flex min-w-0 flex-col gap-0.75", className)}
      {...props}
    />
  );
}

export { Timeline, TimelineContent, TimelineItem, TimelineMarker };
