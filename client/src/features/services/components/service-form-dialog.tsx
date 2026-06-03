import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { SERVICE_UNIT_TYPES } from "@shared/schema";
import { BUDGET_TYPES, BUDGET_TYPE_LABELS } from "@shared/domain/budgets";
import type { ServiceFormData, ServiceWithPots } from "../types";
import { UNIT_TYPE_LABELS, LOHNART_LABELS } from "../constants";

interface ServiceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingService: ServiceWithPots | null;
  form: ServiceFormData;
  onChange: (field: keyof ServiceFormData, value: string | boolean | string[]) => void;
  onToggleBudgetPot: (pot: string) => void;
  onSave: () => void;
  isSaving: boolean;
  hasServiceChanges: boolean;
}

export function ServiceFormDialog({
  open,
  onOpenChange,
  editingService,
  form,
  onChange,
  onToggleBudgetPot,
  onSave,
  isSaving,
  hasServiceChanges,
}: ServiceFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingService ? "Dienstleistung bearbeiten" : "Neue Dienstleistung hinzufügen"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {editingService?.isSystem && (
            <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-sm text-purple-700" data-testid="info-system-service">
              System-Service: Name, Code, Einheit und Status können nicht geändert werden.
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              className="text-base"
              value={form.name}
              onChange={(e) => onChange("name", e.target.value)}
              placeholder="z. B. Hauswirtschaftliche Versorgung"
              disabled={editingService?.isSystem}
              data-testid="input-service-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="unitType">Einheit</Label>
            <Select
              value={form.unitType}
              onValueChange={(value) => onChange("unitType", value)}
              disabled={editingService?.isSystem}
            >
              <SelectTrigger className="text-base" data-testid="select-unit-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_UNIT_TYPES.map((type) => (
                  <SelectItem key={type} value={type} data-testid={`select-unit-type-option-${type}`}>
                    {UNIT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3 py-2">
            <Switch
              id="isBillable"
              checked={form.isBillable}
              onCheckedChange={(checked) => onChange("isBillable", checked)}
              data-testid="switch-is-billable"
            />
            <Label htmlFor="isBillable" className="cursor-pointer">
              Abrechenbar (wird dem Kunden berechnet)
            </Label>
          </div>

          {form.isBillable && (
            <div className="space-y-2">
              <Label htmlFor="defaultPriceCents">Standardpreis (€)</Label>
              <Input
                id="defaultPriceCents"
                className="text-base"
                type="text"
                inputMode="decimal"
                value={form.defaultPriceCents}
                onChange={(e) => onChange("defaultPriceCents", e.target.value)}
                placeholder="0,00"
                data-testid="input-service-price"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="employeeRateCents">Mitarbeiter-Vergütung (€)</Label>
              <Input
                id="employeeRateCents"
                className="text-base"
                type="text"
                inputMode="decimal"
                value={form.employeeRateCents}
                onChange={(e) => onChange("employeeRateCents", e.target.value)}
                placeholder="0,00"
                data-testid="input-service-employee-rate"
              />
              <p className="text-xs text-gray-500">Vergütung pro Einheit</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lohnartKategorie">Lohnart-Kategorie</Label>
              <Select value={form.lohnartKategorie} onValueChange={(v) => onChange("lohnartKategorie", v)}>
                <SelectTrigger id="lohnartKategorie" data-testid="select-lohnart-kategorie">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LOHNART_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">Für Lexware-Lohnexport</p>
            </div>
          </div>

          {form.isBillable && (
            <div className="space-y-2">
              <Label htmlFor="vatRate">MwSt-Satz (%)</Label>
              <Input
                id="vatRate"
                className="text-base"
                type="number"
                inputMode="numeric"
                value={form.vatRate}
                onChange={(e) => onChange("vatRate", e.target.value)}
                placeholder="19"
                data-testid="input-service-vat"
              />
            </div>
          )}

          {form.isBillable && (
            <div className="space-y-2">
              <Label>Budget-Töpfe</Label>
              <div className="space-y-2">
                {BUDGET_TYPES.map((pot) => (
                  <div key={pot} className="flex items-center gap-2">
                    <Checkbox
                      id={`pot-${pot}`}
                      checked={form.budgetPots.includes(pot)}
                      onCheckedChange={() => onToggleBudgetPot(pot)}
                      data-testid={`checkbox-budget-pot-${pot}`}
                    />
                    <Label htmlFor={`pot-${pot}`} className="cursor-pointer text-sm font-normal">
                      {BUDGET_TYPE_LABELS[pot]}
                    </Label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500">Über welche Budget-Töpfe kann diese Leistung abgerechnet werden?</p>
            </div>
          )}

          {form.unitType === "hours" && (
            <div className="space-y-2">
              <Label htmlFor="minDurationMinutes">Mindesteinsatz in Minuten</Label>
              <Input
                id="minDurationMinutes"
                className="text-base"
                type="number"
                inputMode="numeric"
                value={form.minDurationMinutes}
                onChange={(e) => onChange("minDurationMinutes", e.target.value)}
                placeholder="z. B. 60"
                data-testid="input-service-min-duration"
              />
            </div>
          )}


          {!editingService?.isSystem && (
            <div className="flex items-center gap-3 py-2">
              <Switch
                id="isDefault"
                checked={form.isDefault}
                onCheckedChange={(checked) => onChange("isDefault", checked)}
                data-testid="switch-is-default"
              />
              <Label htmlFor="isDefault" className="cursor-pointer">
                Standard bei Terminanlage
              </Label>
            </div>
          )}

          {!editingService?.isSystem && (
            <div className="flex items-center gap-3 py-2">
              <Switch
                id="isActive"
                checked={form.isActive}
                onCheckedChange={(checked) => onChange("isActive", checked)}
                data-testid="switch-is-active"
              />
              <Label htmlFor="isActive" className="cursor-pointer">
                Dienstleistung aktiv
              </Label>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel"
            >
              Abbrechen
            </Button>
            <Button
              type="button"
              className={componentStyles.btnPrimary}
              onClick={onSave}
              disabled={isSaving || !hasServiceChanges}
              title={!isSaving && !hasServiceChanges ? "Keine Änderungen zu speichern" : undefined}
              data-testid="button-save-service"
            >
              {isSaving ? (
                <>
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Speichern...
                </>
              ) : editingService ? (
                "Änderungen speichern"
              ) : (
                "Dienstleistung hinzufügen"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
