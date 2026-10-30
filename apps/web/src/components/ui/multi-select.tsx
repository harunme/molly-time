import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Loading } from "@/components/ui/loading";

export type MultiSelectOption = {
  label: string;
  value: string;
  description?: string;
  searchText?: string;
  disabled?: boolean;
};

type MultiSelectProps = {
  options: MultiSelectOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  loading?: boolean;
  loadingText?: string;
  disabled?: boolean;
  invalid?: boolean;
  showSelectAll?: boolean;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  emptyText = "未找到匹配项",
  loading = false,
  loadingText = "正在加载选项",
  disabled,
  invalid,
  showSelectAll = false,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const selectedValues = React.useMemo(() => new Set(value), [value]);
  const selectedOptions = options.filter((option) =>
    selectedValues.has(option.value),
  );
  const visibleSelectedOptions = selectedOptions.slice(0, 2);
  const selectedLabel = visibleSelectedOptions
    .map((option) => option.label)
    .join("、");
  const hiddenSelectedCount =
    selectedOptions.length - visibleSelectedOptions.length;
  const selectableValues = options
    .filter((option) => !option.disabled)
    .map((option) => option.value);
  const allSelectableValuesSelected =
    selectableValues.length > 0 &&
    selectableValues.every((optionValue) => selectedValues.has(optionValue));

  function toggleValue(optionValue: string) {
    if (selectedValues.has(optionValue)) {
      onValueChange(value.filter((item) => item !== optionValue));
      return;
    }
    onValueChange([...value, optionValue]);
  }

  function selectAll() {
    onValueChange([...new Set([...value, ...selectableValues])]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="bordered"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          data-testid={testId}
          disabled={disabled}
          className={cn(
            "group/multi-select h-control w-full min-w-0 justify-between px-3 text-base font-normal",
            className,
          )}
        >
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              !selectedLabel && "text-placeholder",
            )}
          >
            <span className="min-w-0 truncate">
              {selectedLabel || placeholder}
            </span>
            {hiddenSelectedCount > 0 ? (
              <span className="ml-1 shrink-0">
                +{hiddenSelectedCount}
              </span>
            ) : null}
          </span>
          <ChevronDown className="shrink-0 text-muted-foreground transition-transform duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] group-data-[state=open]/multi-select:rotate-180 motion-reduce:transition-none" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <Command className="max-h-[var(--radix-popover-content-available-height)] min-h-0">
          <CommandInput
            data-testid={testId ? `${testId}-search` : undefined}
            placeholder={searchPlaceholder}
          />
          <CommandList
            role="listbox"
            aria-multiselectable="true"
            className="min-h-0 flex-1 overscroll-contain"
          >
            {loading ? (
              <Loading size="sm" rows={3} variant="list" label={loadingText} className="px-3" />
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                {options.map((option) => {
                  const selected = selectedValues.has(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.description ?? ""} ${option.searchText ?? ""}`}
                      className={cn(!option.description && "py-1.5")}
                      disabled={option.disabled}
                      aria-selected={selected}
                      data-testid={
                        testId ? `${testId}-option-${option.value}` : undefined
                      }
                      onSelect={() => toggleValue(option.value)}
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0 transition-[opacity,transform] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-emphasized)] motion-reduce:transition-none",
                          selected ? "scale-100 opacity-100" : "scale-50 opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        {option.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </>
            )}
          </CommandList>
          {showSelectAll || value.length > 0 ? (
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-xs text-muted-foreground">
                已选择 {value.length} 项
              </span>
              <div className="flex items-center gap-1">
                {showSelectAll ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={testId ? `${testId}-select-all` : undefined}
                    onClick={selectAll}
                    disabled={
                      loading ||
                      selectableValues.length === 0 ||
                      allSelectableValuesSelected
                    }
                  >
                    选择全部
                  </Button>
                ) : null}
                {value.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={testId ? `${testId}-clear` : undefined}
                    onClick={() => onValueChange([])}
                  >
                    清空
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { MultiSelect };
