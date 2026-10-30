import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn("flex h-full w-full flex-col overflow-hidden rounded-ui bg-card text-foreground", className)} {...props} />;
}
function CommandDialog({ title = "命令菜单", children, className, ...props }: React.ComponentProps<typeof Dialog> & { title?: string; className?: string; }) {
  return <Dialog {...props}><DialogContent className={cn("overflow-hidden p-0", className)}><DialogTitle className="sr-only">{title}</DialogTitle><Command>{children}</Command></DialogContent></Dialog>;
}
function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return <div className="flex h-control items-center px-3"><Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" /><CommandPrimitive.Input className={cn("h-full w-full bg-transparent text-sm outline-none placeholder:text-placeholder disabled:opacity-50", className)} {...props} /></div>;
}
function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("max-h-75 overflow-y-auto overflow-x-hidden p-1.5", className)} {...props} />;
}
function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground" {...props} />;
}
function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn("overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground", className)} {...props} />;
}
function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("my-1 h-0.25 bg-border", className)} {...props} />;
}
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return <CommandPrimitive.Item data-slot="command-item" className={cn("relative flex cursor-pointer select-none items-center gap-2 rounded-ui px-3 py-2.5 text-sm outline-none data-[disabled=true]:cursor-not-allowed data-[selected=true]:bg-muted data-[disabled=true]:opacity-50", className)} {...props} />;
}
function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto text-xs text-muted-foreground", className)} {...props} />;
}

export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut };
