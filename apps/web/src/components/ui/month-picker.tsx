import { useRef, useState, type KeyboardEvent } from "react";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type MonthPickerProps = {
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  timeZone?: string;
};

/** Controlled YYYY-MM value; Chinese UI, shared theme and accessible popup. */
export function MonthPicker({ value, onValueChange, min = "1970-01", max = "2100-12",
  disabled, id, className, "aria-label": label, timeZone = "Asia/Shanghai" }: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [yearText, setYearText] = useState(value.slice(0, 4));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const year = Number(yearText);
  const validYear = /^[0-9]{4}$/.test(yearText)
    && year >= Number(min.slice(0, 4)) && year <= Number(max.slice(0, 4));
  const current = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit",
  }).format(new Date());
  const allowed = (month: string) => month >= min && month <= max;
  const choose = (month: string) => { onValueChange(month); setOpen(false); };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next = (index + offset + 12) % 12;
    if (!buttons.current[next]?.disabled) buttons.current[next]?.focus();
  };

  return <Popover open={open} onOpenChange={(next) => {
    if (next) setYearText(value.slice(0, 4));
    setOpen(next);
  }}>
    <PopoverTrigger asChild>
      <Button id={id} type="button" variant="bordered" disabled={disabled} aria-label={label}
        data-slot="month-picker"
        className={cn("w-full justify-start px-3 text-base text-left font-normal tabular-nums", className)}>
        <CalendarIcon className="text-muted-foreground" aria-hidden="true" />
        <span>{Number(value.slice(0, 4))}年{Number(value.slice(5, 7))}月</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent aria-label="选择月份" onOpenAutoFocus={(event) => {
      event.preventDefault();
      buttons.current[Number(value.slice(5, 7)) - 1]?.focus();
    }}>
      <div className="mb-3 flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" aria-label="上一年"
          disabled={!validYear || year <= Number(min.slice(0, 4))}
          onClick={() => setYearText(String(year - 1))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Select value={yearText} onValueChange={setYearText}>
          <SelectTrigger aria-label="选择年份" className="h-8 font-medium"><SelectValue>{yearText}年</SelectValue></SelectTrigger>
          <SelectContent>{Array.from({ length: Number(max.slice(0, 4)) - Number(min.slice(0, 4)) + 1 }, (_, index) => {
            const option = String(Number(min.slice(0, 4)) + index);
            return <SelectItem key={option} value={option}>{option}年</SelectItem>;
          })}</SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="icon" aria-label="下一年"
          disabled={!validYear || year >= Number(max.slice(0, 4))}
          onClick={() => setYearText(String(year + 1))}><ChevronRightIcon aria-hidden="true" /></Button>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="月份">
        {Array.from({ length: 12 }, (_, index) => {
          const month = `${yearText}-${String(index + 1).padStart(2, "0")}`;
          const selected = value === month;
          return <Button key={index} type="button" variant="ghost"
            ref={(button) => { buttons.current[index] = button; }}
            aria-label={`${yearText}年${index + 1}月`} aria-pressed={selected}
            className={cn("min-w-0 px-1", selected && "bg-selection font-semibold")}
            disabled={!validYear || !allowed(month)}
            onKeyDown={(event) => moveFocus(event, index)} onClick={() => choose(month)}>
            {index + 1}月
          </Button>;
        })}
      </div>
      <div className="mt-3 flex justify-end pt-2">
        <Button type="button" variant="ghost" size="sm" disabled={!allowed(current)}
          onClick={() => choose(current)}>本月</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
