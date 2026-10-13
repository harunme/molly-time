// Adapted from smart-afs-platform's shared Calendar / Select structure.
import * as React from "react";
import { DayButton, DayPicker, type DayButtonProps, type DropdownProps } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dateKey } from "@/lib/date-only";
import { cn } from "@/lib/utils";

const TestIdContext = React.createContext<string | undefined>(undefined);

function CalendarDayButton({ day, ...props }: DayButtonProps) {
  const prefix = React.useContext(TestIdContext);
  return <DayButton day={day} {...props} data-testid={prefix ? `${prefix}-day-${dateKey(day.date)}` : undefined} />;
}

function CalendarDropdown({ options, value, onChange, disabled, className, "aria-label": label }: DropdownProps) {
  const selected = options?.find((option) => String(option.value) === String(value));
  return <Select value={value === undefined ? undefined : String(value)} disabled={disabled}
    onValueChange={(next) => onChange?.({ target: { value: next } } as React.ChangeEvent<HTMLSelectElement>)}>
    <SelectTrigger aria-label={label} className={cn("h-8 px-2 font-medium", className)}>
      <SelectValue>{selected?.label}</SelectValue>
    </SelectTrigger>
    <SelectContent>{options?.map((option) => <SelectItem key={option.value} value={String(option.value)} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}

function Calendar({ className, classNames, components, locale = zhCN, showOutsideDays = true,
  testIdPrefix, ...props }: React.ComponentProps<typeof DayPicker> & { testIdPrefix?: string }) {
  return <TestIdContext.Provider value={testIdPrefix}>
    <DayPicker locale={locale} showOutsideDays={showOutsideDays}
      className={cn("shared-calendar relative p-3", className)}
      components={{ DayButton: CalendarDayButton, MonthsDropdown: CalendarDropdown,
        YearsDropdown: CalendarDropdown, ...components }}
      classNames={{
        months: "flex flex-col gap-4 sm:flex-row",
        month: "w-[18rem] max-w-full space-y-3",
        month_caption: "relative flex h-8 items-center justify-center",
        caption_label: "text-sm font-medium",
        dropdowns: "relative z-[2] inline-flex items-center gap-2",
        months_dropdown: "w-[5rem]",
        years_dropdown: "w-[5.5rem]",
        nav: "absolute inset-x-3 top-3 z-[1] flex items-center justify-between",
        button_previous: cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground"),
        button_next: cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground"),
        chevron: "size-4 fill-current",
        month_grid: "w-full border-collapse",
        weekdays: "flex justify-center",
        weekday: "w-9 text-center text-xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full justify-center",
        day: "relative size-9 p-0 text-center text-sm",
        day_button: cn(buttonVariants({ variant: "ghost", size: "icon" }), "min-w-0 font-normal"),
        selected: "[&>button]:bg-primary [&>button]:font-semibold [&>button]:text-primary-foreground [&>button]:hover:bg-primary",
        today: "[&>button]:border [&>button]:border-foreground/30",
        outside: "text-muted-foreground opacity-40",
        disabled: "text-muted-foreground opacity-40",
        hidden: "invisible",
        ...classNames,
      }} {...props} />
  </TestIdContext.Provider>;
}

export { Calendar };
