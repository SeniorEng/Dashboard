import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PICKER_MONTH_NAMES } from "../constants";

interface MonthYearPickerProps {
  initialDate: Date;
  onSelect: (date: Date) => void;
}

export function MonthYearPicker({ initialDate, onSelect }: MonthYearPickerProps) {
  const [pickerYear, setPickerYear] = useState(initialDate.getFullYear());
  const today = useMemo(() => new Date(), []);
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const initialMonth = initialDate.getMonth();
  const initialYear = initialDate.getFullYear();

  const handleSelect = (m: number) => {
    const target = pickerYear === todayYear && m === todayMonth
      ? today
      : new Date(pickerYear, m, 1);
    onSelect(target);
  };

  return (
    <div className="w-60" data-testid="picker-month-year">
      <div className="flex items-center justify-between mb-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setPickerYear(y => y - 1)}
          data-testid="button-picker-prev-year"
          aria-label="Vorheriges Jahr"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-semibold" data-testid="text-picker-year">{pickerYear}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setPickerYear(y => y + 1)}
          data-testid="button-picker-next-year"
          aria-label="Nächstes Jahr"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {PICKER_MONTH_NAMES.map((label, m) => {
          const isCurrent = pickerYear === todayYear && m === todayMonth;
          const isSelected = pickerYear === initialYear && m === initialMonth;
          return (
            <Button
              key={m}
              variant={isSelected ? "default" : "ghost"}
              size="sm"
              className={`h-8 text-xs ${isCurrent && !isSelected ? "ring-1 ring-primary/40" : ""}`}
              onClick={() => handleSelect(m)}
              data-testid={`button-picker-month-${m + 1}`}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
