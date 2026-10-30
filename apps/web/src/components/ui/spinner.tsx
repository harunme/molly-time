import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return <LoaderCircle role="status" aria-label="加载中" className={cn("h-6 w-6 animate-spin text-primary-text motion-reduce:animate-none", className)} {...props} />;
}

export { Spinner };
