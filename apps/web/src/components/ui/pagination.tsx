import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressMotionClassName } from "@/components/ui/motion";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav role="navigation" aria-label="pagination" data-slot="pagination" className={cn("mx-auto flex w-full justify-center", className)} {...props} />;
}
function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="pagination-content" className={cn("flex items-center gap-2", className)} {...props} />;
}
function PaginationItem(props: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}
type PaginationLinkProps = React.ComponentProps<"a"> & { isActive?: boolean; size?: "default" | "sm" | "lg" | "icon"; };
function PaginationLink({ className, isActive, size = "icon", ...props }: PaginationLinkProps) {
  return <a aria-current={isActive ? "page" : undefined} data-slot="pagination-link" data-active={isActive} className={cn(buttonVariants({ variant: isActive ? "bordered" : "ghost", size }), pressMotionClassName, className)} {...props} />;
}
function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button aria-label="上一页" variant="ghost" size="icon" className={className} {...props}><ChevronLeft /><span className="sr-only">上一页</span></Button>;
}
function PaginationNext({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button aria-label="下一页" variant="ghost" size="icon" className={className} {...props}><ChevronRight /><span className="sr-only">下一页</span></Button>;
}
function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return <span aria-hidden data-slot="pagination-ellipsis" className={cn("flex h-control-sm w-control-sm items-center justify-center", className)} {...props}><MoreHorizontal className="h-4 w-4" /><span className="sr-only">更多页面</span></span>;
}

export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious };
