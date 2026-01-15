/**
 * Time Entry Dialog Component
 * 
 * Reusable dialog for creating and editing time entries.
 * Consolidates form markup that was duplicated between new/edit modes.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, AlertCircle, Palmtree, Thermometer, Coffee, Briefcase, FileText } from "lucide-react";
import { iconSize } from "@/design-system";
import type { TimeEntryType } from "@/lib/api/types";
import type { TimeEntryFormState } from "../hooks/use-time-entry-form";
import type { UseTimeEntryConflictResult } from "../hooks/use-time-entry-conflict";

const TIME_ENTRY_TYPE_CONFIG: Record<TimeEntryType, { label: string; icon: React.ElementType; color: string }> = {
  urlaub: { label: "Urlaub", icon: Palmtree, color: "text-green-700" },
  krankheit: { label: "Krankheit", icon: Thermometer, color: "text-red-700" },
  pause: { label: "Pause", icon: Coffee, color: "text-amber-700" },
  bueroarbeit: { label: "Büroarbeit", icon: Briefcase, color: "text-blue-700" },
  vertrieb: { label: "Vertrieb", icon: Briefcase, color: "text-purple-700" },
  schulung: { label: "Schulung", icon: FileText, color: "text-indigo-700" },
  besprechung: { label: "Besprechung", icon: FileText, color: "text-teal-700" },
  sonstiges: { label: "Sonstiges", icon: FileText, color: "text-gray-700" },
};

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
}

export function TimeEntryDialog({
  open,
  onOpenChange,
  title,
  formState,
  onFieldChange,
  validation,
  onSubmit,
  isSubmitting,
  isFullDayType,
  supportsDateRange,
  submitLabel = "Speichern",
  testIdPrefix = "",
}: TimeEntryDialogProps) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
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
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Von</Label>
                <DatePicker
                  value={formState.entryDate || null}
                  onChange={(val) => onFieldChange("entryDate", val || "")}
                  data-testid={`${prefix}input-entry-date`}
                />
              </div>
              <div className="space-y-2">
                <Label>Bis</Label>
                <DatePicker
                  value={formState.endDate || formState.entryDate || null}
                  minDate={formState.entryDate ? new Date(formState.entryDate) : undefined}
                  onChange={(val) => onFieldChange("endDate", val || undefined)}
                  data-testid={`${prefix}input-end-date`}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Datum</Label>
              <DatePicker
                value={formState.entryDate || null}
                onChange={(val) => onFieldChange("entryDate", val || "")}
                data-testid={`${prefix}input-entry-date`}
              />
            </div>
          )}

          {!isFullDayType && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Startzeit</Label>
                <Input
                  type="time"
                  value={formState.startTime || ""}
                  onChange={(e) => onFieldChange("startTime", e.target.value)}
                  className={validation.timeError ? "border-red-500" : ""}
                  data-testid={`${prefix}input-start-time`}
                />
              </div>
              <div className="space-y-2">
                <Label>Endzeit</Label>
                <Input
                  type="time"
                  value={formState.endTime || ""}
                  onChange={(e) => onFieldChange("endTime", e.target.value)}
                  className={validation.timeError ? "border-red-500" : ""}
                  data-testid={`${prefix}input-end-time`}
                />
              </div>
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

          <div className="flex justify-end gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid={`${prefix}button-cancel`}
            >
              Abbrechen
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
