import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Check, ChevronRight, Circle } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName, menuMotionClassName } from "@/components/ui/motion";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn("z-(--z-popover) min-w-40 overflow-hidden rounded-popover border border-card-border bg-card p-1.5 text-foreground shadow-popover", menuMotionClassName, className)} {...props} /></DropdownMenuPrimitive.Portal>;
}
function DropdownMenuItem({ className, inset, variant = "default", ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean; variant?: "default" | "destructive"; }) {
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" data-inset={inset} data-variant={variant} className={cn("relative flex cursor-pointer select-none items-center gap-2 rounded-ui px-3 py-2.25 text-sm outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4", controlMotionClassName, inset && "pl-8", variant === "destructive" && "text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-white", className)} {...props} />;
}
function DropdownMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return <DropdownMenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn("relative flex cursor-pointer select-none items-center rounded-ui py-2.25 pr-3 pl-8 text-sm outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-muted data-[disabled]:opacity-50", className)} checked={checked} {...props}><span className="absolute left-2.5 grid h-4 w-4 place-items-center"><DropdownMenuPrimitive.ItemIndicator><Check className="h-4 w-4" /></DropdownMenuPrimitive.ItemIndicator></span>{children}</DropdownMenuPrimitive.CheckboxItem>;
}
function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return <DropdownMenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn("relative flex cursor-pointer select-none items-center rounded-ui py-2.25 pr-3 pl-8 text-sm outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-muted data-[disabled]:opacity-50", className)} {...props}><span className="absolute left-2.5 grid h-4 w-4 place-items-center"><DropdownMenuPrimitive.ItemIndicator><Circle className="size-1.5 fill-current" /></DropdownMenuPrimitive.ItemIndicator></span>{children}</DropdownMenuPrimitive.RadioItem>;
}
function DropdownMenuLabel({ className, inset, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean; }) {
  return <DropdownMenuPrimitive.Label className={cn("px-3 py-2 text-sm font-semibold", inset && "pl-8", className)} {...props} />;
}
function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("my-1 h-0.25 bg-border", className)} {...props} />;
}
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto text-xs text-muted-foreground", className)} {...props} />;
}
function DropdownMenuSubTrigger({ className, inset, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean; }) {
  return <DropdownMenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" className={cn("flex cursor-pointer select-none items-center rounded-ui px-3 py-2.25 text-sm outline-none data-[disabled]:cursor-not-allowed data-[state=open]:bg-muted data-[disabled]:opacity-50", inset && "pl-8", className)} {...props}>{children}<ChevronRight className="ml-auto h-4 w-4" /></DropdownMenuPrimitive.SubTrigger>;
}
function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return <DropdownMenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn("z-(--z-popover) min-w-40 rounded-popover border border-card-border bg-card p-1.5 shadow-popover", menuMotionClassName, className)} {...props} />;
}

export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger };
