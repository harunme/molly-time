import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function SummaryMetric({
  icon: Icon,
  label,
  value,
  className,
  valueClassName,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[auto_3.5rem] items-center gap-4", className)}>
      <span className="flex items-center gap-3 whitespace-nowrap">
        <Icon className="h-5 w-5 text-metric-icon" />
        <small className="text-sm font-medium text-metric-label">{label}</small>
      </span>
      <strong className={cn("text-right font-mono text-2xl leading-none font-semibold tabular-nums", valueClassName)}>{value}</strong>
    </div>
  );
}

export { SummaryMetric };
