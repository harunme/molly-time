import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName, fieldErrorMotionClassName, menuMotionClassName } from "@/components/ui/motion";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;
const SelectContentSizeContext = React.createContext<"sm" | "default">("default");

function SelectTrigger({ className, size = "default", children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "compact" | "default"; }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "group/select flex min-w-0 w-full cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-[20px] bg-card px-4 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-placeholder [&>span]:min-w-0 [&>span]:flex-1 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
        controlMotionClassName,
        fieldErrorMotionClassName,
        size === "default" && "h-control text-base",
        size === "compact" && "h-control text-base",
        size === "sm" && "h-7 text-sm",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] group-data-[state=open]/select:rotate-180 motion-reduce:transition-none" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
function SelectContent({ className, children, position = "popper", sideOffset = 4, size = "default", ...props }: React.ComponentProps<typeof SelectPrimitive.Content> & { size?: "sm" | "default"; }) {
  return (
    <SelectContentSizeContext.Provider value={size}>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content data-slot="select-content" data-size={size} position={position} sideOffset={sideOffset} className={cn("relative z-(--z-popover) max-h-75 min-w-32 overflow-hidden rounded-popover bg-card text-foreground shadow-popover", menuMotionClassName, className)} {...props}>
          <SelectScrollUpButton />
          <SelectPrimitive.Viewport className={cn("w-full", size === "default" ? "p-1.5" : "p-1", position === "popper" && "min-w-[var(--radix-select-trigger-width)]")}>{children}</SelectPrimitive.Viewport>
          <SelectScrollDownButton />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectContentSizeContext.Provider>
  );
}
function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-3 py-2 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  const size = React.useContext(SelectContentSizeContext);
  return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full min-w-0 cursor-pointer select-none items-center overflow-hidden rounded-ui outline-none transition-[background-color,color] duration-[var(--motion-duration-quick)] data-[disabled]:cursor-not-allowed data-[highlighted]:bg-muted data-[disabled]:text-placeholder motion-reduce:transition-none", size === "default" ? "min-h-9 py-2 pr-8 pl-3 text-sm leading-5" : "min-h-7 py-1 pr-7 pl-2 text-xs leading-4", className)} {...props}><SelectPrimitive.ItemText asChild><span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{children}</span></SelectPrimitive.ItemText><span className={cn("absolute grid place-items-center text-info", size === "default" ? "right-2 h-4 w-4" : "right-1.5 h-3.5 w-3.5")}><SelectPrimitive.ItemIndicator className="animate-[ui-control-mark-in_var(--motion-duration-fast)_var(--motion-ease-emphasized)] motion-reduce:animate-none"><Check className={size === "default" ? "h-4 w-4" : "h-3.5 w-3.5"} /></SelectPrimitive.ItemIndicator></span></SelectPrimitive.Item>;
}
function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("my-1 h-0.25 bg-border", className)} {...props} />;
}
function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return <SelectPrimitive.ScrollUpButton className={cn("flex h-6 items-center justify-center bg-card text-muted-foreground", className)} {...props}><ChevronUp className="h-4 w-4" /></SelectPrimitive.ScrollUpButton>;
}
function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return <SelectPrimitive.ScrollDownButton className={cn("flex h-6 items-center justify-center bg-card text-muted-foreground", className)} {...props}><ChevronDown className="h-4 w-4" /></SelectPrimitive.ScrollDownButton>;
}

type SelectOption = { value: string; label: React.ReactNode; disabled?: boolean; };
type SelectOptionEntry = SelectOption | false | null | undefined | "" | 0 | readonly SelectOptionEntry[];

/** Form composition of the migrated Select; empty business values remain empty. */
function SelectField({ value = "", onValueChange, options, className, id, "aria-label": label,
  disabled, required, name, size = "compact" }: {
    value?: string; onValueChange: (value: string) => void;
    options: readonly SelectOptionEntry[]; className?: string; id?: string;
    "aria-label"?: string; disabled?: boolean; required?: boolean; name?: string;
    size?: "sm" | "compact" | "default";
  }) {
  const items: SelectOption[] = [];
  const collect = (entries: readonly SelectOptionEntry[]) => {
    for (const entry of entries) {
      if (Array.isArray(entry)) collect(entry);
      else if (entry && typeof entry === "object" && "value" in entry) items.push(entry as SelectOption);
    }
  };
  collect(options);
  let emptyValue = "__empty__";
  while (items.some((item) => item.value === emptyValue)) emptyValue += "_";
  return <div data-slot="select-field" className={cn("min-w-0 w-full", className)}>
    <Select value={value || emptyValue} onValueChange={(next) => onValueChange(next === emptyValue ? "" : next)}
      disabled={disabled} required={required} name={name}>
      <SelectTrigger id={id} aria-label={label} size={size} data-value={value}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => <SelectItem key={item.value} value={item.value || emptyValue} disabled={item.disabled} data-value={item.value}>
          {item.label}
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

export { Select, SelectContent, SelectField, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue };
export type { SelectOption };
