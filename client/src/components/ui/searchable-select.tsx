import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";

export interface SearchableSelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
  isLoading?: boolean;
}

export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder = "Auswählen...",
  searchPlaceholder = "Suchen...",
  emptyText = "Keine Ergebnisse gefunden.",
  disabled = false,
  className,
  "data-testid": testId,
  isLoading = false,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const isMobile = useIsMobile();

  const selectedOption = options.find((opt) => opt.value === value);

  const handleSelect = (selectedValue: string) => {
    onValueChange(selectedValue);
    setOpen(false);
  };

  const triggerButton = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled || isLoading}
      className={cn(
        "w-full justify-between min-h-[44px] font-normal text-left bg-white text-gray-900",
        !value && "text-gray-400",
        className
      )}
      data-testid={testId}
    >
      <span className="truncate">
        {isLoading
          ? "Laden..."
          : selectedOption
            ? selectedOption.sublabel
              ? `${selectedOption.label} – ${selectedOption.sublabel}`
              : selectedOption.label
            : placeholder}
      </span>
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  const commandList = (
    <Command shouldFilter={true}>
      <CommandInput
        placeholder={searchPlaceholder}
        className="min-h-[44px]"
      />
      <CommandList className={isMobile ? "max-h-[60vh]" : "max-h-[300px]"}>
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem
              key={option.value}
              value={option.sublabel ? `${option.label} ${option.sublabel}` : option.label}
              onSelect={() => handleSelect(option.value)}
              className="min-h-[44px] cursor-pointer"
              data-testid={testId ? `${testId}-option-${option.value}` : undefined}
            >
              <Check
                className={cn(
                  "mr-2 h-4 w-4 shrink-0",
                  value === option.value ? "opacity-100" : "opacity-0"
                )}
              />
              <div className="flex flex-col min-w-0">
                <span className="truncate font-medium">{option.label}</span>
                {option.sublabel && (
                  <span className="truncate text-xs text-muted-foreground">
                    {option.sublabel}
                  </span>
                )}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => !disabled && !isLoading && setOpen(true)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !disabled && !isLoading) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          {triggerButton}
        </div>
        <DrawerContent className="max-h-[85vh]">
          <VisuallyHidden.Root>
            <DrawerTitle>{placeholder}</DrawerTitle>
          </VisuallyHidden.Root>
          <div className="p-2">
            {commandList}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        {triggerButton}
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        {commandList}
      </PopoverContent>
    </Popover>
  );
}
