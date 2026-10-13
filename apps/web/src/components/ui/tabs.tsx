import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { controlMotionClassName } from "@/components/ui/motion";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("inline-flex min-h-control items-center gap-2", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-h-control flex-1 cursor-pointer items-center justify-center rounded-ui border border-border bg-surface-subtle px-3 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:border-foreground data-[state=active]:bg-card data-[state=active]:font-semibold data-[state=active]:text-foreground",
        controlMotionClassName,
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none data-[state=active]:animate-[ui-tab-content-in_var(--motion-duration-fast)_var(--motion-ease-standard)] motion-reduce:animate-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
