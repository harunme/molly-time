import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DatePickerProps = {
  value?: Date;
  onValueChange?: (date: Date) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  min?: Date;
  max?: Date;
  "aria-label"?: string;
  "data-testid"?: string;
};

/** Same DatePicker + Calendar + Popover composition as the reference project. */
export function DatePicker({ value, onValueChange, placeholder = "选择日期", disabled, className,
  min = new Date(1900, 0, 1), max = new Date(2100, 11, 31),
  "aria-label": label, "data-testid": testId }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const format = (date: Date) => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" aria-label={label} data-testid={testId} disabled={disabled}
        data-slot="date-picker"
        className={cn("w-full justify-start border-transparent bg-input-surface text-left font-normal hover:bg-input-surface", !value && "text-muted-foreground", className)}>
        <CalendarIcon className="text-muted-foreground" aria-hidden="true" />{value ? format(value) : placeholder}
      </Button>
    </PopoverTrigger>
    <PopoverContent aria-label="选择日期" className="w-auto p-0">
      <Calendar testIdPrefix={testId ? `${testId}-calendar` : undefined}
        mode="single" required captionLayout="dropdown" autoFocus
        startMonth={min} endMonth={max} defaultMonth={value} selected={value}
        disabled={[{ before: min }, { after: max }]}
        onSelect={(date) => { onValueChange?.(date); setOpen(false); }} />
    </PopoverContent>
  </Popover>;
}
