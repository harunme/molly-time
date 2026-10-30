import { Slot as SlotPrimitive } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const Slot = SlotPrimitive.Root;

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "group relative flex h-control w-full items-center rounded-[20px] border border-border bg-card focus-within:border-focus-ring focus-within:ring-2 focus-within:ring-focus-ring",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full flex-1 border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & {
  align?: "inline-start" | "inline-end";
}) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4",
        align === "inline-start" ? "pl-3" : "pr-2",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupButton({
  className,
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="input-group-button"
      variant="ghost"
      size={size}
      className={cn("h-7 w-7", className)}
      {...props}
    />
  );
}

function InputGroupText({
  asChild,
  className,
  ...props
}: React.ComponentProps<"span"> & { asChild?: boolean; }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="input-group-text"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
};
