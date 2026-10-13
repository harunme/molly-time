import * as React from "react";
import { cn } from "@/lib/utils";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("flex min-h-36 w-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground", className)} {...props} />;
}
function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex max-w-100 flex-col items-center gap-2", className)} {...props} />;
}
function EmptyMedia(_props: React.ComponentProps<"div"> & { variant?: "default" | "icon"; }) {
  return null;
}
function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("font-semibold text-foreground", className)} {...props} />;
}
function EmptyDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-description" className={cn("text-muted-foreground", className)} {...props} />;
}
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-content" className={cn("flex items-center justify-center gap-2", className)} {...props} />;
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
