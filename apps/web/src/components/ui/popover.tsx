import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({ className, align = "start", sideOffset = 6, ...props }:
  React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset}
      collisionPadding={16}
      className={cn("z-50 w-72 max-w-[calc(100vw-2rem)] rounded-ui border bg-popover p-3 text-popover-foreground shadow-lg outline-none", className)}
      {...props} />
  </PopoverPrimitive.Portal>;
}

export { Popover, PopoverTrigger, PopoverContent };
