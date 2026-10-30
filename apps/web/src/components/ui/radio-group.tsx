import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName } from "@/components/ui/motion";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "h-4 w-4 shrink-0 cursor-pointer rounded-full bg-secondary text-foreground data-[state=checked]:bg-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:not-disabled:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:not-disabled:scale-100",
        controlMotionClassName,
        className,
      )}
      {...props}
    >
      {children ?? <RadioGroupPrimitive.Indicator forceMount data-slot="radio-group-indicator" className="group/radio-indicator grid size-full place-items-center">
        <span className="h-2 w-2 scale-50 rounded-full bg-current opacity-0 transition-[opacity,transform] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-emphasized)] group-data-[state=checked]/radio-indicator:scale-100 group-data-[state=checked]/radio-indicator:opacity-100 motion-reduce:transition-none" />
      </RadioGroupPrimitive.Indicator>}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
