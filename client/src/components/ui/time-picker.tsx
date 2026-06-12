"use client"

import * as React from "react"
import { Clock, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export interface TimePickerProps {
  value?: string | null
  onChange?: (time: string) => void
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  id?: string
  className?: string
  "data-testid"?: string
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function parseTime(value?: string | null): { hour: number; minute: number } | null {
  if (!value) return null
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function ScrollColumn({
  label,
  values,
  selected,
  onSelect,
  testIdPrefix,
}: {
  label: string
  values: number[]
  selected: number
  onSelect: (value: number) => void
  testIdPrefix: string
}) {
  const selectedRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "center" })
    }
  }, [])

  return (
    <div className="flex flex-col min-w-0">
      <span className="text-xs font-medium text-muted-foreground text-center mb-1">
        {label}
      </span>
      <div className="h-[220px] overflow-y-auto px-1 flex flex-col gap-1">
        {values.map((v) => (
          <button
            key={v}
            ref={v === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(v)}
            className={cn(
              "min-h-[44px] min-w-[60px] rounded-md text-base font-medium transition-colors shrink-0",
              v === selected
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            )}
            data-testid={`${testIdPrefix}-${pad2(v)}`}
          >
            {pad2(v)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function TimePicker({
  value,
  onChange,
  placeholder = "Uhrzeit wählen",
  disabled = false,
  clearable = true,
  id,
  className,
  "data-testid": testId,
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const parsed = React.useMemo(() => parseTime(value), [value])
  const [draftHour, setDraftHour] = React.useState<number>(parsed?.hour ?? 0)
  const [draftMinute, setDraftMinute] = React.useState<number>(parsed?.minute ?? 0)

  React.useEffect(() => {
    if (open) {
      setDraftHour(parsed?.hour ?? 0)
      setDraftMinute(parsed?.minute ?? 0)
    }
  }, [open, parsed])

  const handleConfirm = () => {
    onChange?.(`${pad2(draftHour)}:${pad2(draftMinute)}`)
    setOpen(false)
  }

  const handleClear = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onChange?.("")
  }

  const displayValue = parsed ? `${pad2(parsed.hour)}:${pad2(parsed.minute)}` : null
  const showClear = clearable && !!displayValue && !disabled

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <div className="relative flex items-center">
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            disabled={disabled}
            className={cn(
              "w-full justify-start text-left font-normal min-h-[44px] px-3",
              showClear && "pr-9",
              !displayValue && "text-muted-foreground",
              className
            )}
            data-testid={testId}
          >
            <Clock className="mr-2 h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">
              {displayValue ? `${displayValue} Uhr` : placeholder}
            </span>
          </Button>
        </PopoverTrigger>
        {showClear && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2 p-1 rounded-full hover:bg-muted transition-colors min-w-[24px] min-h-[24px] flex items-center justify-center"
            aria-label="Uhrzeit löschen"
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <PopoverContent
        className="w-auto p-3"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex gap-3 items-start">
          <ScrollColumn
            label="Stunde"
            values={HOURS}
            selected={draftHour}
            onSelect={setDraftHour}
            testIdPrefix="btn-hour"
          />
          <div className="self-center text-2xl font-semibold text-muted-foreground pt-5">
            :
          </div>
          <ScrollColumn
            label="Minute"
            values={MINUTES}
            selected={draftMinute}
            onSelect={setDraftMinute}
            testIdPrefix="btn-minute"
          />
        </div>
        <Button
          type="button"
          className="w-full mt-3 min-h-[44px]"
          onClick={handleConfirm}
          data-testid="btn-confirm-time"
        >
          Übernehmen
        </Button>
      </PopoverContent>
    </Popover>
  )
}

TimePicker.displayName = "TimePicker"
