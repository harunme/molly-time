import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon, MinusIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName } from "@/components/ui/motion";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer h-4 w-4 shrink-0 cursor-pointer rounded-control-mark bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:not-disabled:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground motion-reduce:active:not-disabled:scale-100",
        controlMotionClassName,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator forceMount data-slot="checkbox-indicator" className="group/checkbox-indicator relative grid size-full place-items-center">
        <CheckIcon strokeWidth={3} className="absolute h-3 w-3 scale-75 opacity-0 transition-[opacity,transform] duration-[var(--motion-duration-quick)] ease-[var(--motion-ease-emphasized)] group-data-[state=checked]/checkbox-indicator:scale-100 group-data-[state=checked]/checkbox-indicator:opacity-100 motion-reduce:transition-none" />
        <MinusIcon className="absolute h-3 w-3 scale-75 opacity-0 transition-[opacity,transform] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-emphasized)] group-data-[state=indeterminate]/checkbox-indicator:scale-100 group-data-[state=indeterminate]/checkbox-indicator:opacity-100 motion-reduce:transition-none" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
