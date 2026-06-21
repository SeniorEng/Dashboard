"use client"

import * as React from "react"
import { Clock, X, Keyboard } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

type DialMode = "hours" | "minutes"
type InputMode = "dial" | "keyboard"

const DIAL_SIZE = 256
const CENTER = DIAL_SIZE / 2
const OUTER_RADIUS = 104
const INNER_RADIUS = 64
const MINUTE_RADIUS = 104
const RING_THRESHOLD = (OUTER_RADIUS + INNER_RADIUS) / 2
const HANDLE_RADIUS = 19

const OUTER_HOURS = Array.from({ length: 12 }, (_, i) => i) // 0..11
const INNER_HOURS = Array.from({ length: 12 }, (_, i) => i + 12) // 12..23
const MINUTE_MARKS = Array.from({ length: 12 }, (_, i) => i * 5) // 0,5,..,55

/** Position on the dial for a 12-step ring slot (0 at top, clockwise). */
function polar(radius: number, slot: number): { x: number; y: number } {
  const angleDeg = slot * 30 - 90
  const rad = (angleDeg * Math.PI) / 180
  return {
    x: CENTER + radius * Math.cos(rad),
    y: CENTER + radius * Math.sin(rad),
  }
}

function ClockDial({
  mode,
  hour,
  minute,
  onHourChange,
  onMinuteChange,
  onHourCommitted,
}: {
  mode: DialMode
  hour: number
  minute: number
  onHourChange: (hour: number) => void
  onMinuteChange: (minute: number) => void
  onHourCommitted: () => void
}) {
  const svgRef = React.useRef<SVGSVGElement>(null)
  const draggingRef = React.useRef(false)

  const computeValue = React.useCallback(
    (clientX: number, clientY: number, isDrag: boolean) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const px = ((clientX - rect.left) / rect.width) * DIAL_SIZE
      const py = ((clientY - rect.top) / rect.height) * DIAL_SIZE
      const dx = px - CENTER
      const dy = py - CENTER
      const dist = Math.sqrt(dx * dx + dy * dy)
      // Clock angle: 0° at top, increasing clockwise.
      const clockAngle = (Math.atan2(dy, dx) * 180) / Math.PI + 90

      if (mode === "hours") {
        const slot = ((Math.round(clockAngle / 30) % 12) + 12) % 12
        const inner = dist < RING_THRESHOLD
        onHourChange(inner ? slot + 12 : slot)
      } else {
        let m: number
        if (isDrag) {
          m = ((Math.round(clockAngle / 6) % 60) + 60) % 60
        } else {
          m = ((Math.round(clockAngle / 30) * 5) % 60 + 60) % 60
        }
        onMinuteChange(m)
      }
    },
    [mode, onHourChange, onMinuteChange]
  )

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    draggingRef.current = true
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* setPointerCapture can fail in some environments — drag still works */
    }
    computeValue(e.clientX, e.clientY, false)
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return
    computeValue(e.clientX, e.clientY, true)
  }

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      svgRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (mode === "hours") {
      onHourCommitted()
    }
  }

  // Hand geometry for the currently selected value.
  let handAngleDeg: number
  let handRadius: number
  if (mode === "hours") {
    handAngleDeg = (hour % 12) * 30 - 90
    handRadius = hour < 12 ? OUTER_RADIUS : INNER_RADIUS
  } else {
    handAngleDeg = minute * 6 - 90
    handRadius = MINUTE_RADIUS
  }
  const handRad = (handAngleDeg * Math.PI) / 180
  const handX = CENTER + handRadius * Math.cos(handRad)
  const handY = CENTER + handRadius * Math.sin(handRad)
  const minuteIsOffMark = mode === "minutes" && minute % 5 !== 0

  const renderHourNumbers = (hours: number[], radius: number, fontSize: number) =>
    hours.map((h) => {
      const slot = h % 12
      const { x, y } = polar(radius, slot)
      const selected = h === hour
      return (
        <g
          key={h}
          data-testid={`btn-hour-${pad2(h)}`}
          role="button"
          aria-label={`${h} Uhr`}
        >
          <circle cx={x} cy={y} r={18} fill="transparent" />
          <text
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontSize}
            className={cn(
              "select-none pointer-events-none font-medium",
              selected ? "fill-primary-foreground" : "fill-foreground"
            )}
          >
            {pad2(h)}
          </text>
        </g>
      )
    })

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
      width={DIAL_SIZE}
      height={DIAL_SIZE}
      className="touch-none select-none mx-auto max-w-full"
      role="slider"
      aria-label={mode === "hours" ? "Stunde wählen" : "Minute wählen"}
      aria-valuemin={0}
      aria-valuemax={mode === "hours" ? 23 : 59}
      aria-valuenow={mode === "hours" ? hour : minute}
      data-testid="time-dial"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Dial face */}
      <circle cx={CENTER} cy={CENTER} r={CENTER - 4} className="fill-muted" />

      {/* Selection hand */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={handX}
        y2={handY}
        strokeWidth={2}
        className="stroke-primary"
      />
      <circle cx={handX} cy={handY} r={HANDLE_RADIUS} className="fill-primary" data-testid="time-dial-handle" />
      {minuteIsOffMark && (
        <circle cx={handX} cy={handY} r={2.5} className="fill-primary-foreground" />
      )}
      <circle cx={CENTER} cy={CENTER} r={4} className="fill-primary" />

      {/* Numbers */}
      {mode === "hours" ? (
        <>
          {renderHourNumbers(OUTER_HOURS, OUTER_RADIUS, 16)}
          {renderHourNumbers(INNER_HOURS, INNER_RADIUS, 13)}
        </>
      ) : (
        MINUTE_MARKS.map((m) => {
          const { x, y } = polar(MINUTE_RADIUS, m / 5)
          const selected = m === minute
          return (
            <g
              key={m}
              data-testid={`btn-minute-${pad2(m)}`}
              role="button"
              aria-label={`${m} Minuten`}
            >
              <circle cx={x} cy={y} r={18} fill="transparent" />
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={16}
                className={cn(
                  "select-none pointer-events-none font-medium",
                  selected ? "fill-primary-foreground" : "fill-foreground"
                )}
              >
                {pad2(m)}
              </text>
            </g>
          )
        })
      )}
    </svg>
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
  const [dialMode, setDialMode] = React.useState<DialMode>("hours")
  const [inputMode, setInputMode] = React.useState<InputMode>("dial")

  React.useEffect(() => {
    if (open) {
      setDraftHour(parsed?.hour ?? 0)
      setDraftMinute(parsed?.minute ?? 0)
      setDialMode("hours")
      setInputMode("dial")
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
        className="w-[288px] p-3"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">
            {inputMode === "dial"
              ? dialMode === "hours"
                ? "Stunde wählen"
                : "Minute wählen"
              : "Uhrzeit eingeben"}
          </span>
          <button
            type="button"
            onClick={() => setInputMode((m) => (m === "dial" ? "keyboard" : "dial"))}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground min-w-[36px] min-h-[36px] flex items-center justify-center"
            aria-label={
              inputMode === "dial"
                ? "Zur Tastatureingabe wechseln"
                : "Zur Uhr-Ansicht wechseln"
            }
            data-testid="btn-time-input-mode-toggle"
          >
            {inputMode === "dial" ? (
              <Keyboard className="h-4 w-4" />
            ) : (
              <Clock className="h-4 w-4" />
            )}
          </button>
        </div>

        {inputMode === "dial" ? (
          <>
            {/* HH : MM header */}
            <div className="flex items-center justify-center gap-1 mb-3">
              <button
                type="button"
                onClick={() => setDialMode("hours")}
                className={cn(
                  "min-w-[56px] min-h-[44px] rounded-md text-3xl font-semibold tabular-nums transition-colors",
                  dialMode === "hours"
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-muted"
                )}
                aria-label="Stunde bearbeiten"
                aria-pressed={dialMode === "hours"}
                data-testid="btn-time-hour-segment"
              >
                {pad2(draftHour)}
              </button>
              <span className="text-3xl font-semibold text-muted-foreground">:</span>
              <button
                type="button"
                onClick={() => setDialMode("minutes")}
                className={cn(
                  "min-w-[56px] min-h-[44px] rounded-md text-3xl font-semibold tabular-nums transition-colors",
                  dialMode === "minutes"
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-muted"
                )}
                aria-label="Minute bearbeiten"
                aria-pressed={dialMode === "minutes"}
                data-testid="btn-time-minute-segment"
              >
                {pad2(draftMinute)}
              </button>
            </div>

            <ClockDial
              mode={dialMode}
              hour={draftHour}
              minute={draftMinute}
              onHourChange={setDraftHour}
              onMinuteChange={setDraftMinute}
              onHourCommitted={() => setDialMode("minutes")}
            />
          </>
        ) : (
          <div className="flex items-end justify-center gap-2 py-4">
            <div className="flex flex-col items-center gap-1">
              <label
                htmlFor="time-input-hour"
                className="text-xs font-medium text-muted-foreground"
              >
                Stunde
              </label>
              <Input
                id="time-input-hour"
                type="number"
                min={0}
                max={23}
                inputMode="numeric"
                value={pad2(draftHour)}
                onChange={(e) =>
                  setDraftHour(clampInt(Number(e.target.value), 0, 23))
                }
                className="w-20 h-14 text-center text-2xl font-semibold tabular-nums"
                aria-label="Stunde"
                data-testid="input-time-hour"
              />
            </div>
            <span className="text-2xl font-semibold text-muted-foreground pb-3">:</span>
            <div className="flex flex-col items-center gap-1">
              <label
                htmlFor="time-input-minute"
                className="text-xs font-medium text-muted-foreground"
              >
                Minute
              </label>
              <Input
                id="time-input-minute"
                type="number"
                min={0}
                max={59}
                inputMode="numeric"
                value={pad2(draftMinute)}
                onChange={(e) =>
                  setDraftMinute(clampInt(Number(e.target.value), 0, 59))
                }
                className="w-20 h-14 text-center text-2xl font-semibold tabular-nums"
                aria-label="Minute"
                data-testid="input-time-minute"
              />
            </div>
          </div>
        )}

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
