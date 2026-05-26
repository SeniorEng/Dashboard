import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2, AlertCircle, Users } from "lucide-react";
import { iconSize } from "@/design-system";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TimeEntryType } from "@/lib/api/types";
import type { TimeEntryFormState } from "../hooks/use-time-entry-form";
import type { UseTimeEntryConflictResult } from "../hooks/use-time-entry-conflict";
import { TIME_ENTRY_TYPE_CONFIG } from "../constants";
import { parseLocalDate } from "@shared/utils/datetime";
import { entryTypeSupportsKilometers } from "@shared/domain/time-entries";
import { getVacationHolidayDates, getVacationHolidayName } from "@shared/utils/holidays";
import { useMemo } from "react";

export interface EmployeeOption {
  value: string;
  label: string;
}

export interface TimeEntryFormContentProps {
  formState: TimeEntryFormState;
  onFieldChange: <K extends keyof TimeEntryFormState>(field: K, value: TimeEntryFormState[K]) => void;
  validation: UseTimeEntryConflictResult;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  isFullDayType: boolean;
  supportsDateRange: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  testIdPrefix?: string;
  isAdmin?: boolean;
  employeeOptions?: EmployeeOption[];
  hideFooter?: boolean;
}

export interface TimeEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  formState: TimeEntryFormState;
  onFieldChange: <K extends keyof TimeEntryFormState>(field: K, value: TimeEntryFormState[K]) => void;
  validation: UseTimeEntryConflictResult;
  onSubmit: () => void;
  isSubmitting: boolean;
  isFullDayType: boolean;
  supportsDateRange: boolean;
  submitLabel?: string;
  testIdPrefix?: string;
  isAdmin?: boolean;
  employeeOptions?: EmployeeOption[];
}

export function TimeEntryFormContent({
  formState,
  onFieldChange,
  validation,
  onSubmit,
  onCancel,
  isSubmitting,
  isFullDayType,
  supportsDateRange,
  submitLabel = "Speichern",
  cancelLabel = "Abbrechen",
  testIdPrefix = "",
  isAdmin = false,
  employeeOptions = [],
  hideFooter = false,
}: TimeEntryFormContentProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
    <div className="space-y-4 pt-4">
      {isAdmin && employeeOptions.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <Users className={iconSize.sm} />
            Mitarbeiter
          </Label>
          <SearchableSelect
            options={employeeOptions}
            value={formState.targetUserId?.toString() || ""}
            onValueChange={(val) => onFieldChange("targetUserId", val ? parseInt(val) : null)}
            placeholder="Für mich selbst (Standard)"
            searchPlaceholder="Mitarbeiter suchen..."
            data-testid={`${prefix}select-target-employee`}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label>Art</Label>
        <Select
          value={formState.entryType}
          onValueChange={(value) => onFieldChange("entryType", value as TimeEntryType)}
        >
          <SelectTrigger data-testid={`${prefix}select-entry-type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(TIME_ENTRY_TYPE_CONFIG).map(([type, config]) => (
              <SelectItem key={type} value={type}>
                <div className="flex items-center gap-2">
                  <config.icon />
                  {config.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {supportsDateRange ? (
        <>
          <div className="space-y-2">
            <Label>Von</Label>
            <DatePicker
              value={formState.entryDate || null}
              onChange={(val) => onFieldChange("entryDate", val || "")}
              disableWeekends
              data-testid={`${prefix}input-entry-date`}
            />
          </div>
          <div className="space-y-2">
            <Label>Bis</Label>
            <DatePicker
              value={formState.endDate || formState.entryDate || null}
              minDate={formState.entryDate ? parseLocalDate(formState.entryDate) : undefined}
              onChange={(val) => onFieldChange("endDate", val || undefined)}
              disableWeekends
              data-testid={`${prefix}input-end-date`}
            />
          </div>
          <VacationRangePreview
            entryType={formState.entryType}
            startDate={formState.entryDate}
            endDate={formState.endDate || formState.entryDate}
            testIdPrefix={prefix}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label>Datum</Label>
            <DatePicker
              value={formState.entryDate || null}
              onChange={(val) => onFieldChange("entryDate", val || "")}
              disableWeekends
              data-testid={`${prefix}input-entry-date`}
            />
          </div>
          <SingleDayHolidayHint
            entryType={formState.entryType}
            date={formState.entryDate}
            testIdPrefix={prefix}
          />
        </>
      )}

      {!isFullDayType && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Startzeit</Label>
            <Input
              type="time"
              value={formState.startTime || ""}
              onChange={(e) => onFieldChange("startTime", e.target.value)}
              className={`text-base ${validation.timeError ? "border-red-500" : ""}`}
              data-testid={`${prefix}input-start-time`}
            />
          </div>
          <div className="space-y-2">
            <Label>Endzeit</Label>
            <Input
              type="time"
              value={formState.endTime || ""}
              onChange={(e) => onFieldChange("endTime", e.target.value)}
              className={`text-base ${validation.timeError ? "border-red-500" : ""}`}
              data-testid={`${prefix}input-end-time`}
            />
          </div>
        </div>
      )}

      {entryTypeSupportsKilometers(formState.entryType, isFullDayType) && (
        <div className="space-y-2">
          <Label>Kilometer (optional)</Label>
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="0"
            value={formState.kilometers ?? ""}
            onChange={(e) => onFieldChange("kilometers", e.target.value ? parseFloat(e.target.value) : null)}
            className="text-base"
            data-testid={`${prefix}input-kilometers`}
          />
        </div>
      )}

      {(validation.timeError || validation.conflict) && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2" data-testid={`${prefix}validation-warning`}>
          <AlertCircle className={`${iconSize.md} text-red-600 shrink-0 mt-0.5`} />
          <p className="text-sm text-red-700">{validation.timeError || validation.conflict}</p>
        </div>
      )}

      <div className="space-y-2">
        <Label>Notizen (optional)</Label>
        <Textarea
          value={formState.notes || ""}
          onChange={(e) => onFieldChange("notes", e.target.value)}
          placeholder="Optionale Bemerkungen..."
          data-testid={`${prefix}input-notes`}
        />
      </div>

      {!hideFooter && (
        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={onCancel}
            className="min-h-[44px]"
            data-testid={`${prefix}button-cancel`}
          >
            {cancelLabel}
          </Button>
          <Button
            className="bg-teal-600 hover:bg-teal-700 min-h-[44px]"
            onClick={onSubmit}
            disabled={isSubmitting || validation.hasError}
            data-testid={`${prefix}button-save`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Speichern...
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Task #602: Live-Vorschau für Urlaubs-Mehrtagesbereiche.
 * Berechnet client-seitig die echten Werktage zwischen `startDate` und
 * `endDate` (Wochenenden + Feiertage gefiltert). Holt nichts vom Server,
 * weil `getVacationHolidayDates` rein deterministisch ist.
 */
function VacationRangePreview({
  entryType,
  startDate,
  endDate,
  testIdPrefix,
}: {
  entryType: TimeEntryType;
  startDate: string;
  endDate: string;
  testIdPrefix: string;
}) {
  const breakdown = useMemo(() => {
    if (entryType !== "urlaub") return null;
    if (!startDate || !endDate) return null;
    if (endDate < startDate) return null;
    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);
    const holidayCache = new Map<number, Set<string>>();
    const holidayNameCache = new Map<string, string>();
    let workdays = 0;
    let weekendDays = 0;
    const holidays: Array<{ date: string; name: string }> = [];
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      const iso = `${y}-${m}-${d}`;
      const dow = cursor.getDay();
      if (dow === 0 || dow === 6) {
        weekendDays += 1;
      } else {
        let set = holidayCache.get(y);
        if (!set) {
          set = getVacationHolidayDates(y);
          holidayCache.set(y, set);
        }
        if (set.has(iso)) {
          let name = holidayNameCache.get(iso);
          if (!name) {
            name = getVacationHolidayName(iso) ?? "Feiertag";
            holidayNameCache.set(iso, name);
          }
          holidays.push({ date: iso, name });
        } else {
          workdays += 1;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return { workdays, weekendDays, holidays };
  }, [entryType, startDate, endDate]);

  if (!breakdown) return null;

  const { workdays, weekendDays, holidays } = breakdown;
  const skipParts: string[] = [];
  if (holidays.length > 0) {
    skipParts.push(`${holidays.length} ${holidays.length === 1 ? "Feiertag" : "Feiertage"}`);
  }
  if (weekendDays > 0) {
    skipParts.push(`${weekendDays} ${weekendDays === 1 ? "Wochenendtag" : "Wochenendtage"}`);
  }

  return (
    <div
      className="p-3 bg-teal-50 border border-teal-200 rounded-lg text-sm"
      data-testid={`${testIdPrefix}vacation-range-preview`}
    >
      <p className="text-teal-900">
        <span className="font-semibold" data-testid={`${testIdPrefix}vacation-workdays-count`}>
          {workdays} {workdays === 1 ? "Werktag" : "Werktage"}
        </span>
        {skipParts.length > 0 && (
          <span className="text-teal-700">
            {" "}({skipParts.join(" und ")} werden nicht abgezogen)
          </span>
        )}
      </p>
      {holidays.length > 0 && (
        <ul className="mt-1 text-xs text-teal-700 list-disc list-inside" data-testid={`${testIdPrefix}vacation-holidays-list`}>
          {holidays.map((h) => (
            <li key={h.date}>
              {h.date.split("-").reverse().join(".")} – {h.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Task #602: Hinweis im Single-Day-Modus, wenn ein gesetzlicher Feiertag
 * ausgewählt ist und der Eintrags-Typ `urlaub` ist. Der Backend lehnt den
 * Speichern-Versuch ohnehin ab — die Frontend-Vorwarnung erspart dem
 * Nutzer den fehlgeschlagenen Roundtrip.
 */
function SingleDayHolidayHint({
  entryType,
  date,
  testIdPrefix,
}: {
  entryType: TimeEntryType;
  date: string;
  testIdPrefix: string;
}) {
  if (entryType !== "urlaub" || !date) return null;
  const name = getVacationHolidayName(date);
  if (!name) return null;
  const display = date.split("-").reverse().join(".");
  return (
    <div
      className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800"
      data-testid={`${testIdPrefix}vacation-holiday-warning`}
    >
      Der {display} ist ein gesetzlicher Feiertag ({name}) und kann nicht als Urlaubstag gebucht werden.
    </div>
  );
}

export function TimeEntryDialog(props: TimeEntryDialogProps) {
  const { open, onOpenChange, title, ...formProps } = props;
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6 overflow-y-auto max-h-[80vh]">
            <TimeEntryFormContent {...formProps} onCancel={() => onOpenChange(false)} />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <TimeEntryFormContent {...formProps} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
