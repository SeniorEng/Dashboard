"use client"

import * as React from "react"
import { format, parseISO, isValid } from "date-fns"
import { de } from "date-fns/locale"
import { CalendarIcon, X, ChevronLeft, ChevronRight } from "lucide-react"

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

type PickerView = "days" | "years" | "months"

const MONTH_NAMES_DE = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
]

const YEARS_PER_PAGE = 12

function YearPicker({
  selectedYear,
  onSelect,
  minYear,
  maxYear,
}: {
  selectedYear: number
  onSelect: (year: number) => void
  minYear: number
  maxYear: number
}) {
  const [pageStart, setPageStart] = React.useState(() => {
    const page = Math.floor((selectedYear - minYear) / YEARS_PER_PAGE)
    return minYear + page * YEARS_PER_PAGE
  })

  const pageEnd = Math.min(pageStart + YEARS_PER_PAGE - 1, maxYear)
  const canPrev = pageStart > minYear
  const canNext = pageStart + YEARS_PER_PAGE <= maxYear

  const years: number[] = []
  for (let y = pageStart; y <= pageEnd; y++) {
    years.push(y)
  }

  return (
    <div className="p-3 w-[280px]">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setPageStart(Math.max(minYear, pageStart - YEARS_PER_PAGE))}
          disabled={!canPrev}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          data-testid="btn-year-page-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">
          {pageStart} – {pageEnd}
        </span>
        <button
          type="button"
          onClick={() => setPageStart(Math.min(maxYear - YEARS_PER_PAGE + 1, pageStart + YEARS_PER_PAGE))}
          disabled={!canNext}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          data-testid="btn-year-page-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {years.map((year) => (
          <button
            key={year}
            type="button"
            onClick={() => onSelect(year)}
            className={cn(
              "min-h-[44px] rounded-md text-sm font-medium transition-colors",
              year === selectedYear
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            )}
            data-testid={`btn-year-${year}`}
          >
            {year}
          </button>
        ))}
      </div>
    </div>
  )
}

function MonthPicker({
  selectedMonth,
  selectedYear,
  onSelect,
}: {
  selectedMonth: number
  selectedYear: number
  onSelect: (month: number) => void
}) {
  return (
    <div className="p-3 w-[280px]">
      <div className="flex items-center justify-center mb-3">
        <span className="text-sm font-medium">{selectedYear}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {MONTH_NAMES_DE.map((name, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onSelect(index)}
            className={cn(
              "min-h-[44px] rounded-md text-sm font-medium transition-colors",
              index === selectedMonth
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            )}
            data-testid={`btn-month-${index}`}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
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
  const [view, setView] = React.useState<PickerView>("days")
  const [navMonth, setNavMonth] = React.useState<Date>(() => new Date())

  const currentYear = new Date().getFullYear()
  const minYear = minDate ? minDate.getFullYear() : 1900
  const maxYear = maxDate ? maxDate.getFullYear() : currentYear + 10

  const dateValue = React.useMemo(() => {
    if (!value) return undefined
    try {
      const parsed = parseISO(value)
      return isValid(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }, [value])

  React.useEffect(() => {
    if (open) {
      setView("days")
      if (dateValue) {
        setNavMonth(dateValue)
      } else {
        setNavMonth(new Date())
      }
    }
  }, [open, dateValue])

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

  const handleYearSelect = (year: number) => {
    setNavMonth(new Date(year, navMonth.getMonth(), 1))
    setView("months")
  }

  const handleMonthSelect = (month: number) => {
    setNavMonth(new Date(navMonth.getFullYear(), month, 1))
    setView("days")
  }

  const handleCaptionClick = () => {
    setView("years")
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
        {view === "years" && (
          <YearPicker
            selectedYear={navMonth.getFullYear()}
            onSelect={handleYearSelect}
            minYear={minYear}
            maxYear={maxYear}
          />
        )}
        {view === "months" && (
          <MonthPicker
            selectedMonth={navMonth.getMonth()}
            selectedYear={navMonth.getFullYear()}
            onSelect={handleMonthSelect}
          />
        )}
        {view === "days" && (
          <Calendar
            mode="single"
            selected={dateValue}
            onSelect={handleSelect}
            month={navMonth}
            onMonthChange={setNavMonth}
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
            components={{
              CaptionLabel: ({ children }) => (
                <button
                  type="button"
                  onClick={handleCaptionClick}
                  className="text-sm font-medium hover:bg-muted px-2 py-1 rounded-md transition-colors cursor-pointer"
                  data-testid="btn-caption-year-month"
                >
                  {children}
                </button>
              ),
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

DatePicker.displayName = "DatePicker"
