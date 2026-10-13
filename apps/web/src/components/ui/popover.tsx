import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { menuMotionClassName } from "@/components/ui/motion";

type LegacyPopoverProps = {
  children: React.ReactElement;
  content: React.ReactNode;
};
const PopoverOpenContext = React.createContext(false);

function Popover(
  props: React.ComponentProps<typeof PopoverPrimitive.Root> | LegacyPopoverProps,
) {
  const [localOpen, setLocalOpen] = React.useState("defaultOpen" in props ? props.defaultOpen : false);
  if ("content" in props) {
    const { children, content } = props;
    return (
      <PopoverOpenContext.Provider value={!!localOpen}>
        <PopoverPrimitive.Root open={localOpen} onOpenChange={setLocalOpen}>
          <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
          <PopoverContent role="dialog">{content}</PopoverContent>
        </PopoverPrimitive.Root>
      </PopoverOpenContext.Provider>
    );
  }
  const { open: controlledOpen, onOpenChange, defaultOpen: _defaultOpen, ...rest } = props;
  const open = controlledOpen ?? localOpen;
  return <PopoverOpenContext.Provider value={!!open}>
    <PopoverPrimitive.Root data-slot="popover" {...rest} open={open} onOpenChange={(next) => {
      setLocalOpen(next); onOpenChange?.(next);
    }} />
  </PopoverOpenContext.Provider>;
}
function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}
function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}
function PopoverContent({ className, align = "center", sideOffset = 4, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const open = React.useContext(PopoverOpenContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        aria-hidden={!open || undefined}
        className={cn("z-(--z-popover) w-80 rounded-popover border border-card-border bg-card p-3 text-foreground shadow-popover outline-none", menuMotionClassName, className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
