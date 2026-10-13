import { CalendarIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const formatDate = (date: Date) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const DEFAULT_START_MONTH = new Date(1900, 0);
const DEFAULT_END_MONTH = new Date(2100, 11);

function DatePicker({ value, onValueChange, selectFirstDayOnMonthChange = false, selectFirstDayOnYearChange = false, placeholder = "选择日期", disabled, className, "aria-label": ariaLabel, "data-testid": testId }: { value?: Date; onValueChange?: (value: Date | undefined) => void; selectFirstDayOnMonthChange?: boolean; selectFirstDayOnYearChange?: boolean; placeholder?: string; disabled?: boolean; className?: string; "aria-label"?: string; "data-testid"?: string; }) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const interactedOutside = React.useRef(false);

  const handleSelect = (nextValue: Date) => {
    interactedOutside.current = false;
    onValueChange?.(nextValue);
    setOpen(false);
  };

  const handleMonthDropdownSelect = (month: Date) => {
    if (!selectFirstDayOnMonthChange) return;
    onValueChange?.(month);
  };

  const handleYearDropdownSelect = (month: Date) => {
    if (!selectFirstDayOnYearChange) return;
    onValueChange?.(month);
  };

  return (
    <Popover open={open} onOpenChange={(next) => {
      if (next) interactedOutside.current = false;
      setOpen(next);
    }}>
      <PopoverTrigger asChild>
        <Button ref={trigger} type="button" variant="bordered" data-slot="date-picker" aria-label={ariaLabel} data-testid={testId} disabled={disabled} className={cn("w-full justify-start px-3 text-base text-left font-normal tabular-nums", !value && "text-placeholder", className)}>
          <CalendarIcon />{value ? formatDate(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="选择日期" align="start" className="w-auto p-0"
        onEscapeKeyDown={() => { interactedOutside.current = false; }}
        onInteractOutside={() => { interactedOutside.current = true; }}
        onCloseAutoFocus={(event) => {
          if (!interactedOutside.current) {
            event.preventDefault(); trigger.current?.focus();
          }
        }}>
        <Calendar
          testIdPrefix={testId ? `${testId}-calendar` : undefined}
          mode="single"
          required
          autoFocus
          captionLayout="dropdown"
          startMonth={DEFAULT_START_MONTH}
          endMonth={DEFAULT_END_MONTH}
          defaultMonth={value}
          selected={value}
          onSelect={handleSelect}
          onMonthDropdownSelect={handleMonthDropdownSelect}
          onYearDropdownSelect={handleYearDropdownSelect}
        />
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker };
