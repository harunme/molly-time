import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-slot="select-trigger"
    className={cn("flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-ui border border-transparent bg-input-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&>span]:truncate", className)} {...props}>
    {children}<SelectPrimitive.Icon asChild><ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Content data-slot="select-content" position="popper" sideOffset={4} collisionPadding={16}
      className={cn("relative z-[60] max-h-60 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-ui border bg-popover text-popover-foreground shadow-lg", className)} {...props}>
      <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUpIcon className="size-4" /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="max-h-[var(--radix-select-content-available-height)] p-1">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDownIcon className="size-4" /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>;
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-slot="select-item"
    className={cn("relative flex min-h-8 cursor-pointer items-center rounded-ui py-1.5 pr-8 pl-3 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-40", className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2"><CheckIcon className="size-4" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}

export { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
