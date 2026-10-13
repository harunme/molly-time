import { Slot as SlotPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const Slot = SlotPrimitive.Root;

const badgeVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-ui border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-foreground bg-foreground text-white",
        secondary: "border-border-strong bg-surface-subtle text-muted-foreground",
        bordered: "border-border-strong bg-card text-muted-foreground",
        destructive: "border-destructive bg-destructive-surface text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, asChild = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean; }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
