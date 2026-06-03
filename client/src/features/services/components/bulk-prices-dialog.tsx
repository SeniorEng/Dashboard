import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import type { ServiceWithPots } from "../types";
import { UNIT_TYPE_LABELS, UNIT_SUFFIX } from "../constants";
import { formatPrice } from "../utils";

interface BulkPricesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: ServiceWithPots[] | undefined;
  bulkPrices: Record<number, string>;
  setBulkPrices: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  bulkPercent: string;
  setBulkPercent: (value: string) => void;
  bulkSaving: boolean;
  onApplyBulkPercent: () => void;
  onSave: () => void;
  onCancel: () => void;
  hasBulkChanges: boolean;
}

export function BulkPricesDialog({
  open,
  onOpenChange,
  services,
  bulkPrices,
  setBulkPrices,
  bulkPercent,
  setBulkPercent,
  bulkSaving,
  onApplyBulkPercent,
  onSave,
  onCancel,
  hasBulkChanges,
}: BulkPricesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-bulk-prices">
        <DialogHeader>
          <DialogTitle>Standardpreise anpassen</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-700">
            Hier passen Sie die Standardpreise des Katalogs an. Sie gelten automatisch für alle Kunden ohne individuellen Preis. Kundenindividuelle Preise bleiben unverändert.
          </div>

          <div className="space-y-2 border rounded-lg p-3">
            <Label htmlFor="bulk-percent">Pauschale prozentuale Anpassung</Label>
            <div className="flex items-center gap-2">
              <Input
                id="bulk-percent"
                type="text"
                inputMode="decimal"
                value={bulkPercent}
                onChange={(e) => setBulkPercent(e.target.value)}
                placeholder="z. B. 5 für +5 %"
                className="text-base"
                data-testid="input-bulk-percent"
              />
              <span className="text-sm text-gray-500">%</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onApplyBulkPercent}
                disabled={!bulkPercent}
                data-testid="button-apply-bulk-percent"
              >
                Anwenden
              </Button>
            </div>
            <p className="text-xs text-gray-500">
              Berechnet aus den aktuellen Werten und überschreibt die Eingabefelder unten. Negative Werte (z. B. -10) für Senkungen.
            </p>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">Dienstleistung</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-500">Aktuell</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-500">Neu (€)</th>
                </tr>
              </thead>
              <tbody>
                {(services || [])
                  .filter(s => s.isBillable && s.isActive)
                  .map((s) => {
                    const suffix = UNIT_SUFFIX[s.unitType] || "";
                    return (
                      <tr key={s.id} className="border-t" data-testid={`bulk-row-${s.id}`}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-gray-500">{UNIT_TYPE_LABELS[s.unitType] || s.unitType}{suffix}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                          {formatPrice(s.defaultPriceCents)} €
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={bulkPrices[s.id] ?? ""}
                            onChange={(e) => setBulkPrices(prev => ({ ...prev, [s.id]: e.target.value }))}
                            className="h-8 text-sm text-right w-24 ml-auto"
                            placeholder="0,00"
                            data-testid={`input-bulk-price-${s.id}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                {(services || []).filter(s => s.isBillable && s.isActive).length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-sm text-gray-500">
                      Keine abrechenbaren Dienstleistungen vorhanden.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500">
            Es werden nur veränderte Preise gespeichert. Die Anpassung wirkt sich auf zukünftige Abrechnungen aus.
          </p>

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={bulkSaving}
              data-testid="button-cancel-bulk"
            >
              Abbrechen
            </Button>
            <Button
              type="button"
              className={componentStyles.btnPrimary}
              onClick={onSave}
              disabled={bulkSaving || !hasBulkChanges}
              title={!bulkSaving && !hasBulkChanges ? "Keine Änderungen zu speichern" : undefined}
              data-testid="button-save-bulk"
            >
              {bulkSaving ? (
                <>
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Speichern...
                </>
              ) : (
                "Änderungen speichern"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
