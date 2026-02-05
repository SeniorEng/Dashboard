"use client"

import * as React from "react"
import { format, parseISO, isValid } from "date-fns"
import { de } from "date-fns/locale"
import { CalendarIcon, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export interface DatePickerProps {
  value?: string | null
  onChange?: (date: string | null) => void
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  minDate?: Date
  maxDate?: Date
  disableWeekends?: boolean
  className?: string
  "data-testid"?: string
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Datum wählen",
  disabled = false,
  clearable = true,
  minDate,
  maxDate,
  disableWeekends = false,
  className,
  "data-testid": testId,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)

  const dateValue = React.useMemo(() => {
    if (!value) return undefined
    try {
      const parsed = parseISO(value)
      return isValid(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }, [value])

  const handleSelect = (date: Date | undefined) => {
    if (date) {
      const isoDate = format(date, "yyyy-MM-dd")
      onChange?.(isoDate)
    } else {
      onChange?.(null)
    }
    setOpen(false)
  }

  const handleClear = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onChange?.(null)
  }

  const displayValue = React.useMemo(() => {
    if (!dateValue) return null
    return format(dateValue, "d. MMMM yyyy", { locale: de })
  }, [dateValue])

  const showClear = clearable && value && !disabled

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <div className="relative flex items-center">
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            className={cn(
              "w-full justify-start text-left font-normal min-h-[44px] px-3",
              showClear && "pr-9",
              !value && "text-muted-foreground",
              className
            )}
            data-testid={testId}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">
              {displayValue || placeholder}
            </span>
          </Button>
        </PopoverTrigger>
        {showClear && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2 p-1 rounded-full hover:bg-muted transition-colors min-w-[24px] min-h-[24px] flex items-center justify-center"
            aria-label="Datum löschen"
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <PopoverContent 
        className="w-auto p-0" 
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Calendar
          mode="single"
          selected={dateValue}
          onSelect={handleSelect}
          disabled={(date) => {
            if (minDate && date < minDate) return true
            if (maxDate && date > maxDate) return true
            if (disableWeekends) {
              const day = date.getDay()
              if (day === 0 || day === 6) return true
            }
            return false
          }}
          locale={de}
          weekStartsOn={1}
          initialFocus
          classNames={{
            day: "min-w-[44px] min-h-[44px] text-base",
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

DatePicker.displayName = "DatePicker"
