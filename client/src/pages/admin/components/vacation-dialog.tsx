import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { VacationSummary } from "@/lib/api/types";

interface VacationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  year: number;
  userName?: string;
  vacation: VacationSummary | null | undefined;
  vacationLoading: boolean;
  vacationDays: string;
  onVacationDaysChange: (value: string) => void;
  carryOverDays: string;
  onCarryOverDaysChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
}

export function VacationDialog({
  open,
  onOpenChange,
  year,
  userName,
  vacation,
  vacationLoading,
  vacationDays,
  onVacationDaysChange,
  carryOverDays,
  onCarryOverDaysChange,
  onSave,
  onCancel,
  isSaving,
}: VacationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Urlaubskontingent {year} - {userName}
          </DialogTitle>
        </DialogHeader>
        {vacationLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className={`${iconSize.lg} animate-spin`} />
          </div>
        ) : (
          <div className="space-y-4 pt-4">
            {vacation && (
              <div className="p-4 rounded-lg bg-gray-50 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Genommen:</span>
                  <span className="font-medium text-green-700">{vacation.usedDays} {vacation.usedDays === 1 ? 'Tag' : 'Tage'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Geplant:</span>
                  <span className="font-medium text-blue-700">{vacation.plannedDays} {vacation.plannedDays === 1 ? 'Tag' : 'Tage'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Verfügbar:</span>
                  <span className="font-medium text-teal-700">{vacation.remainingDays} {vacation.remainingDays === 1 ? 'Tag' : 'Tage'}</span>
                </div>
                <div className="flex justify-between text-sm border-t pt-2">
                  <span>Krankheitstage:</span>
                  <span className="font-medium text-red-700">{vacation.sickDays} {vacation.sickDays === 1 ? 'Tag' : 'Tage'}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="totalDays">Jahresurlaub (Tage)</Label>
                <Input
                  id="totalDays"
                  type="number"
                  value={vacationDays}
                  onChange={(e) => onVacationDaysChange(e.target.value)}
                  min={0}
                  max={365}
                  data-testid="input-total-days"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="carryOverDays">Resturlaub Vorjahr</Label>
                <Input
                  id="carryOverDays"
                  type="number"
                  value={carryOverDays}
                  onChange={(e) => onCarryOverDaysChange(e.target.value)}
                  min={0}
                  max={365}
                  data-testid="input-carry-over"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={onCancel}>
                Abbrechen
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700"
                onClick={onSave}
                disabled={isSaving}
                data-testid="button-save-vacation"
              >
                {isSaving ? (
                  <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Speichern...</>
                ) : (
                  "Speichern"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
