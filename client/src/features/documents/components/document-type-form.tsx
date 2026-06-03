import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Loader2,
  FileCheck2,
  CalendarClock,
  Shield,
  Filter,
  Info,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { CONTEXT_OPTIONS, RENEWAL_PRESETS } from "../constants";
import type { DocTypeFormData, DocumentTypeData, TriggerData } from "../types";
import { TriggerRow } from "./trigger-row";

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2 pb-1">
      <div className="mt-0.5 text-teal-600">{icon}</div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500">{subtitle}</p>}
      </div>
    </div>
  );
}

interface DocumentTypeFormProps {
  formData: DocTypeFormData;
  setFormData: React.Dispatch<React.SetStateAction<DocTypeFormData>>;
  triggers: TriggerData[];
  editingType: DocumentTypeData | null;
  isPending: boolean;
  onAddTrigger: () => void;
  onTriggerChange: (index: number, updated: TriggerData) => void;
  onTriggerRemove: (index: number) => void;
  onSubmit: () => void;
}

export function DocumentTypeForm({
  formData,
  setFormData,
  triggers,
  editingType,
  isPending,
  onAddTrigger,
  onTriggerChange,
  onTriggerRemove,
  onSubmit,
}: DocumentTypeFormProps) {
  return (
    <div className="space-y-1 pt-2 max-h-[70vh] overflow-y-auto pr-1">

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <SectionHeader
          icon={<FileCheck2 className="h-4 w-4" />}
          title="Grundeinstellungen"
          subtitle="Name und Art des Dokuments"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Name *</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData(p => ({ ...p, name: e.target.value }))}
              placeholder="z.B. Führerschein"
              className="text-base"
              data-testid="input-doctype-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Beschreibung</Label>
            <Input
              value={formData.description}
              onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
              placeholder="Optionale Beschreibung"
              className="text-base"
              data-testid="input-doctype-description"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Zielgruppe *</Label>
            <Select value={formData.targetType} onValueChange={(v) => setFormData(p => ({ ...p, targetType: v, ...(v === "employee" ? { context: "beide" } : {}) }))}>
              <SelectTrigger data-testid="select-doctype-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="employee">Mitarbeiter</SelectItem>
                <SelectItem value="customer">Kunde</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Eingabemethode</Label>
            <Select value={formData.inputMethod} onValueChange={(v) => setFormData(p => ({ ...p, inputMethod: v }))}>
              <SelectTrigger data-testid="select-doctype-input-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upload">Nur Upload</SelectItem>
                <SelectItem value="signature">Nur digitale Unterschrift</SelectItem>
                <SelectItem value="both">Upload oder Unterschrift</SelectItem>
                <SelectItem value="info">Zur Kenntnisnahme</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {formData.targetType === "customer" && (
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Kontext</Label>
            <Select value={formData.context} onValueChange={(v) => setFormData(p => ({ ...p, context: v }))}>
              <SelectTrigger data-testid="select-doctype-context">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-gray-500">Wann wird dieses Dokument benötigt?</p>
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-3">
            <Switch
              checked={formData.isActive}
              onCheckedChange={(v) => setFormData(p => ({ ...p, isActive: v }))}
              data-testid="switch-doctype-active"
            />
            <Label className="text-sm">Aktiv</Label>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <SectionHeader
          icon={<CalendarClock className="h-4 w-4" />}
          title="Gültigkeit & Fristen"
          subtitle="Wiedervorlage, Prüfintervalle und Erinnerungen"
        />
        <div className="space-y-1.5">
          <Label className="text-xs text-gray-500">Wiedervorlage (Tage)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min="1"
              value={formData.renewalDays}
              onChange={(e) => setFormData(p => ({ ...p, renewalDays: e.target.value }))}
              placeholder="Leer = keine"
              className="text-base flex-1"
              data-testid="input-doctype-renewal-days"
            />
            <div className="flex gap-1">
              {RENEWAL_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant={formData.renewalDays === preset.value ? "default" : "outline"}
                  size="sm"
                  className={`text-xs px-2 ${formData.renewalDays === preset.value ? "bg-teal-600 hover:bg-teal-700" : ""}`}
                  onClick={() => setFormData(p => ({ ...p, renewalDays: preset.value }))}
                  data-testid={`button-renewal-preset-${preset.value}`}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-gray-500">Nach Ablauf wird ein neues Dokument angefordert</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Prüffrist (Monate)</Label>
            <Input
              type="number"
              min="1"
              value={formData.reviewIntervalMonths}
              onChange={(e) => setFormData(p => ({ ...p, reviewIntervalMonths: e.target.value }))}
              placeholder="Leer = keine"
              className="text-base"
              data-testid="input-doctype-interval"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500">Erinnerung (Tage vorher)</Label>
            <Input
              type="number"
              min="1"
              max="365"
              value={formData.reminderLeadTimeDays}
              onChange={(e) => setFormData(p => ({ ...p, reminderLeadTimeDays: e.target.value }))}
              placeholder="14"
              className="text-base"
              data-testid="input-doctype-leadtime"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <SectionHeader
          icon={<Filter className="h-4 w-4" />}
          title="Regeln & Bedingungen"
          subtitle="Für wen gilt dieses Dokument?"
        />

        <div className="flex items-center gap-3 py-2 px-3 rounded-lg border bg-amber-50/50">
          <Switch
            checked={formData.isMandatory}
            onCheckedChange={(v) => setFormData(p => ({ ...p, isMandatory: v }))}
            data-testid="switch-doctype-mandatory"
          />
          <div>
            <Label className="flex items-center gap-1 text-sm">
              <Shield className="h-3.5 w-3.5 text-amber-600" />
              Immer verpflichtend
            </Label>
            <p className="text-[11px] text-gray-500">Gilt automatisch für alle {formData.targetType === "customer" ? "Kunden" : "Mitarbeiter"}</p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-gray-500">Zusätzliche Bedingungen</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={onAddTrigger}
              disabled={formData.isMandatory}
              data-testid="button-add-trigger"
            >
              <Plus className="h-3 w-3 mr-1" />
              Hinzufügen
            </Button>
          </div>

          {formData.isMandatory && (
            <div className="flex items-start gap-2 p-2.5 rounded-md bg-blue-50 border border-blue-200" data-testid="text-mandatory-hint">
              <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
              <p className="text-xs text-blue-700">
                Bedingungen werden ignoriert, solange „Immer verpflichtend" aktiv ist.
              </p>
            </div>
          )}

          {triggers.length === 0 ? (
            <div className="text-center py-3 text-sm text-gray-500 border border-dashed rounded-lg" data-testid="text-no-triggers">
              {formData.isMandatory
                ? "Keine weiteren Bedingungen nötig (gilt bereits für alle)"
                : "Keine Bedingungen — wird nur manuell zugewiesen"}
            </div>
          ) : (
            <div className={`space-y-2 ${formData.isMandatory ? "opacity-50 pointer-events-none" : ""}`} data-testid="trigger-list">
              {triggers.map((trigger, index) => (
                <TriggerRow
                  key={index}
                  trigger={trigger}
                  index={index}
                  entityType={formData.targetType}
                  onChange={onTriggerChange}
                  onRemove={onTriggerRemove}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <Button
        className={`w-full mt-3 ${componentStyles.btnPrimary}`}
        onClick={onSubmit}
        disabled={isPending || !formData.name.trim()}
        data-testid="button-save-doctype"
      >
        {isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
        {editingType ? "Aktualisieren" : "Erstellen"}
      </Button>
    </div>
  );
}
