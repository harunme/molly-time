import { Check, ChevronDown, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ComboboxOption = { label: string; value: string; disabled?: boolean; };

function Combobox({ options, value, onValueChange, placeholder = "请选择", searchPlaceholder = "搜索…", emptyText = "未找到匹配项", disabled, className, clearable = false, clearLabel = "清除选择", "aria-label": ariaLabel, "data-testid": testId }: {
  options: ComboboxOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  clearable?: boolean;
  clearLabel?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <div className={cn("relative min-w-0", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="bordered"
            role="combobox"
            aria-label={ariaLabel}
            data-testid={testId}
            aria-expanded={open}
            disabled={disabled}
            className="group/combobox h-control w-full min-w-0 justify-between px-3 text-base font-normal"
          >
            <span className={cn("truncate", !selected && "text-placeholder")}>{selected?.label || placeholder}</span>
            <ChevronDown className="text-muted-foreground transition-transform duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] group-data-[state=open]/combobox:rotate-180 motion-reduce:transition-none" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command>
            <CommandInput data-testid={testId ? `${testId}-search` : undefined} placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  disabled={option.disabled}
                  data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                  className="cursor-pointer"
                  onSelect={() => {
                    onValueChange?.(option.value);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4 transition-[opacity,transform] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-emphasized)] motion-reduce:transition-none", option.value === value ? "scale-100 opacity-100" : "scale-50 opacity-0")} />
                  {option.label}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearable && selected && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          data-testid={testId ? `${testId}-clear` : undefined}
          className="absolute top-1 right-8 z-[1] h-control-sm w-control-sm"
          onClick={() => onValueChange?.("")}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

export { Combobox };
