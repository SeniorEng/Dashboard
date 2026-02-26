import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, AlertCircle } from "lucide-react";
import { iconSize } from "@/design-system";
import { useIsMobile } from "@/hooks/use-mobile";
import type { TimeEntryType } from "@/lib/api/types";
import type { TimeEntryFormState } from "../hooks/use-time-entry-form";
import type { UseTimeEntryConflictResult } from "../hooks/use-time-entry-conflict";
import { TIME_ENTRY_TYPE_CONFIG } from "../constants";

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

function TimeEntryFormContent({
  formState,
  onFieldChange,
  validation,
  onSubmit,
  onOpenChange,
  isSubmitting,
  isFullDayType,
  supportsDateRange,
  submitLabel = "Speichern",
  testIdPrefix = "",
}: Omit<TimeEntryDialogProps, "open" | "title">) {
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
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
              minDate={formState.entryDate ? new Date(formState.entryDate) : undefined}
              onChange={(val) => onFieldChange("endDate", val || undefined)}
              disableWeekends
              data-testid={`${prefix}input-end-date`}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label>Datum</Label>
          <DatePicker
            value={formState.entryDate || null}
            onChange={(val) => onFieldChange("entryDate", val || "")}
            disableWeekends
            data-testid={`${prefix}input-entry-date`}
          />
        </div>
      )}

      {!isFullDayType && (
        <>
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
        </>
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
          className="min-h-[44px]"
          data-testid={`${prefix}button-cancel`}
        >
          Abbrechen
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
            <TimeEntryFormContent {...formProps} onOpenChange={onOpenChange} />
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
        <TimeEntryFormContent {...formProps} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
