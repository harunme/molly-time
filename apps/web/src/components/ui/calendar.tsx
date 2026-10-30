import {
  DayButton as DayPickerDayButton,
  DayPicker,
  NextMonthButton as DayPickerNextMonthButton,
  PreviousMonthButton as DayPickerPreviousMonthButton,
  type DayButtonProps,
  type DropdownProps,
  type NextMonthButtonProps,
  type PreviousMonthButtonProps,
  useDayPicker,
} from "react-day-picker";
import * as React from "react";
import { zhCN } from "react-day-picker/locale";
import { buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const CalendarTestIdContext = React.createContext<string | undefined>(undefined);
const CalendarMonthDropdownContext = React.createContext<((month: Date) => void) | undefined>(undefined);
const CalendarYearDropdownContext = React.createContext<((month: Date) => void) | undefined>(undefined);

function calendarDayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function TestableDayButton({ day, ...props }: DayButtonProps) {
  const testIdPrefix = React.useContext(CalendarTestIdContext);
  return (
    <DayPickerDayButton
      day={day}
      {...props}
      data-testid={testIdPrefix ? `${testIdPrefix}-day-${calendarDayKey(day.date)}` : undefined}
    />
  );
}

function CalendarSelectDropdown({ options, value, onChange, disabled, className, "aria-label": ariaLabel, testId }: DropdownProps & { testId?: string; }) {
  const selectedValue = value === undefined ? undefined : String(value);
  const selectedOption = options?.find((option) => String(option.value) === selectedValue);

  return (
    <Select
      value={selectedValue}
      disabled={disabled}
      onValueChange={(nextValue) => onChange?.({ target: { value: nextValue } } as React.ChangeEvent<HTMLSelectElement>)}
    >
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn("h-control-sm bg-surface-subtle px-2.5 font-medium", className)}
      >
        <SelectValue>{selectedOption?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent data-testid={testId ? `${testId}-content` : undefined} align="center" className="z-(--z-tooltip) max-h-60 min-w-20">
        {options?.map((option) => (
          <SelectItem
            key={option.value}
            value={String(option.value)}
            disabled={option.disabled}
            data-testid={testId ? `${testId}-option-${option.value}` : undefined}
            className="min-h-control-sm py-1.5"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TestableMonthsDropdown(props: DropdownProps) {
  const testIdPrefix = React.useContext(CalendarTestIdContext);
  const onMonthDropdownSelect = React.useContext(CalendarMonthDropdownContext);
  const { months } = useDayPicker();
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    props.onChange?.(event);
    const displayedMonth = months[0]?.date;
    if (displayedMonth) {
      onMonthDropdownSelect?.(
        new Date(displayedMonth.getFullYear(), Number(event.target.value), 1),
      );
    }
  };
  return (
    <CalendarSelectDropdown
      {...props}
      onChange={handleChange}
      testId={testIdPrefix ? `${testIdPrefix}-month-select` : undefined}
    />
  );
}

function TestableYearsDropdown(props: DropdownProps) {
  const testIdPrefix = React.useContext(CalendarTestIdContext);
  const onYearDropdownSelect = React.useContext(CalendarYearDropdownContext);
  const { months } = useDayPicker();
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    props.onChange?.(event);
    const displayedMonth = months[0]?.date;
    if (displayedMonth) {
      onYearDropdownSelect?.(
        new Date(Number(event.target.value), displayedMonth.getMonth(), 1),
      );
    }
  };
  return (
    <CalendarSelectDropdown
      {...props}
      onChange={handleChange}
      testId={testIdPrefix ? `${testIdPrefix}-year-select` : undefined}
    />
  );
}

function TestablePreviousMonthButton(props: PreviousMonthButtonProps) {
  const testIdPrefix = React.useContext(CalendarTestIdContext);
  return <DayPickerPreviousMonthButton {...props} data-testid={testIdPrefix ? `${testIdPrefix}-previous-month-button` : undefined} />;
}

function TestableNextMonthButton(props: NextMonthButtonProps) {
  const testIdPrefix = React.useContext(CalendarTestIdContext);
  return <DayPickerNextMonthButton {...props} data-testid={testIdPrefix ? `${testIdPrefix}-next-month-button` : undefined} />;
}

function Calendar({ className, classNames, locale = zhCN, showOutsideDays = true, testIdPrefix, onMonthDropdownSelect, onYearDropdownSelect, ...props }: React.ComponentProps<typeof DayPicker> & { testIdPrefix?: string; onMonthDropdownSelect?: (month: Date) => void; onYearDropdownSelect?: (month: Date) => void; }) {
  return (
    <CalendarTestIdContext.Provider value={testIdPrefix}>
      <CalendarMonthDropdownContext.Provider value={onMonthDropdownSelect}>
        <CalendarYearDropdownContext.Provider value={onYearDropdownSelect}>
          <DayPicker
            locale={locale}
            showOutsideDays={showOutsideDays}
            className={cn("relative p-3", className)}
            components={{
              DayButton: TestableDayButton,
              MonthsDropdown: TestableMonthsDropdown,
              PreviousMonthButton: TestablePreviousMonthButton,
              NextMonthButton: TestableNextMonthButton,
              YearsDropdown: TestableYearsDropdown,
            }}
            classNames={{
              months: "flex flex-col gap-4 sm:flex-row",
              month: "w-80 max-w-full space-y-4",
              month_caption: "relative flex h-control-sm items-center justify-center",
              caption_label: "text-sm font-medium",
              dropdowns: "relative z-[2] inline-flex items-center gap-2",
              months_dropdown: "w-20",
              years_dropdown: "w-22",
              nav: "absolute inset-x-3 top-3 z-[1] flex items-center justify-between",
              button_previous: cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-control-sm w-control-sm text-muted-foreground hover:text-foreground"),
              button_next: cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-control-sm w-control-sm text-muted-foreground hover:text-foreground"),
              month_grid: "w-full border-collapse",
              weekdays: "flex justify-center",
              weekday: "w-9 text-center text-xs font-normal text-muted-foreground",
              week: "mt-1 flex w-full justify-center",
              day: "relative h-9 w-9 p-0 text-center text-sm",
              day_button: cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9 min-w-0 font-normal"),
              selected: "[&>button]:bg-selection [&>button]:text-foreground [&>button]:hover:bg-selection",
              today: "[&>button]:font-semibold [&>button]:text-info",
              outside: "text-placeholder opacity-50",
              disabled: "text-placeholder opacity-50",
              hidden: "invisible",
              ...classNames,
            }}
            {...props}
          />
        </CalendarYearDropdownContext.Provider>
      </CalendarMonthDropdownContext.Provider>
    </CalendarTestIdContext.Provider>
  );
}

export { Calendar };
