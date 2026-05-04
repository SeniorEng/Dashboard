import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Pencil,
  FileCheck2,
  CalendarClock,
  Bell,
  Users,
  User,
  FileText,
  X,
  Upload,
  PenTool,
  Shield,
  RotateCcw,
  Filter,
  Info,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import {
  INPUT_METHOD_LABELS,
  TRIGGER_OPERATOR_LABELS,
  REQUIREMENT_LEVEL_LABELS,
} from "@shared/schema/documents";
import {
  TRIGGER_FIELD_REGISTRY,
  getTriggerFieldsForEntityType,
  getTriggerFieldDefinition,
  type TriggerFieldDefinition,
} from "@shared/domain/document-triggers";

interface DocumentTypeData {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  context: string;
  inputMethod: string;
  isMandatory: boolean;
  renewalDays: number | null;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
  hasTemplate: boolean;
  templateName: string | null;
  templateSlug: string | null;
}

interface TriggerData {
  id?: number;
  entityType: string;
  triggerType: string;
  conditionField: string | null;
  conditionOperator: string;
  conditionValue: string | null;
  requirement: string;
  sortOrder: number;
  isActive: boolean;
}

interface DocTypeFormData {
  name: string;
  description: string;
  targetType: string;
  context: string;
  inputMethod: string;
  isMandatory: boolean;
  renewalDays: string;
  reviewIntervalMonths: string;
  reminderLeadTimeDays: string;
  isActive: boolean;
}

const CONTEXT_OPTIONS = [
  { value: "beide", label: "Immer verfügbar" },
  { value: "bestandskunde", label: "Nur bei Bestandskunden" },
  { value: "vertragsabschluss", label: "Nur bei Vertragsabschluss" },
];

const RENEWAL_PRESETS = [
  { value: "90", label: "90 Tage" },
  { value: "180", label: "180 Tage" },
  { value: "365", label: "365 Tage" },
];

const emptyForm: DocTypeFormData = {
  name: "",
  description: "",
  targetType: "employee",
  context: "beide",
  inputMethod: "upload",
  isMandatory: false,
  renewalDays: "",
  reviewIntervalMonths: "",
  reminderLeadTimeDays: "14",
  isActive: true,
};

function toFormData(dt: DocumentTypeData): DocTypeFormData {
  return {
    name: dt.name,
    description: dt.description || "",
    targetType: dt.targetType || "employee",
    context: dt.context || "beide",
    inputMethod: dt.inputMethod || "upload",
    isMandatory: dt.isMandatory ?? false,
    renewalDays: dt.renewalDays?.toString() || "",
    reviewIntervalMonths: dt.reviewIntervalMonths?.toString() || "",
    reminderLeadTimeDays: dt.reminderLeadTimeDays?.toString() || "14",
    isActive: dt.isActive,
  };
}

function toPayload(form: DocTypeFormData) {
  return {
    name: form.name,
    description: form.description || null,
    targetType: form.targetType,
    context: form.context,
    inputMethod: form.inputMethod,
    isMandatory: form.isMandatory,
    renewalDays: form.renewalDays ? parseInt(form.renewalDays) : null,
    reviewIntervalMonths: form.reviewIntervalMonths ? parseInt(form.reviewIntervalMonths) : null,
    reminderLeadTimeDays: form.reminderLeadTimeDays ? parseInt(form.reminderLeadTimeDays) : 14,
    isActive: form.isActive,
  };
}

function createEmptyTrigger(entityType: string): TriggerData {
  return {
    entityType,
    triggerType: "field_match",
    conditionField: null,
    conditionOperator: "equals",
    conditionValue: null,
    requirement: "pflicht",
    sortOrder: 0,
    isActive: true,
  };
}

function TriggerRow({
  trigger,
  index,
  entityType,
  onChange,
  onRemove,
}: {
  trigger: TriggerData;
  index: number;
  entityType: string;
  onChange: (index: number, updated: TriggerData) => void;
  onRemove: (index: number) => void;
}) {
  const availableFields = getTriggerFieldsForEntityType(entityType as "customer" | "employee");
  const selectedFieldDef = trigger.conditionField
    ? getTriggerFieldDefinition(trigger.conditionField)
    : undefined;

  const handleTriggerTypeChange = (type: string) => {
    if (type === "always") {
      onChange(index, {
        ...trigger,
        triggerType: "always",
        conditionField: null,
        conditionOperator: "equals",
        conditionValue: null,
      });
    } else {
      onChange(index, {
        ...trigger,
        triggerType: type,
        conditionField: null,
        conditionOperator: "equals",
        conditionValue: null,
      });
    }
  };

  const handleFieldChange = (field: string) => {
    const fieldDef = getTriggerFieldDefinition(field);
    const defaultOp = fieldDef?.operators[0] || "equals";
    const isRole = fieldDef?.entityType === "employee" && fieldDef.valueType === "boolean";
    onChange(index, {
      ...trigger,
      triggerType: isRole ? "role" : "field_match",
      conditionField: field,
      conditionOperator: defaultOp,
      conditionValue: fieldDef?.valueType === "boolean" ? "true" : null,
    });
  };

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-gray-50 relative" data-testid={`trigger-row-${index}`}>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1 right-1 h-6 w-6 p-0 text-gray-500 hover:text-red-500"
        onClick={() => onRemove(index)}
        data-testid={`button-remove-trigger-${index}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <div className="grid grid-cols-2 gap-2 pr-6">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Typ</Label>
          <Select
            value={trigger.triggerType}
            onValueChange={handleTriggerTypeChange}
          >
            <SelectTrigger className="h-8 text-sm" data-testid={`select-trigger-type-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="field_match">Feldabgleich</SelectItem>
              <SelectItem value="role">Rolle</SelectItem>
              <SelectItem value="always">Immer (alle)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Anforderung</Label>
          <Select
            value={trigger.requirement}
            onValueChange={(v) => onChange(index, { ...trigger, requirement: v })}
          >
            <SelectTrigger className="h-8 text-sm" data-testid={`select-trigger-requirement-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pflicht">Pflicht</SelectItem>
              <SelectItem value="optional">Optional</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {trigger.triggerType !== "always" && (
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Feld</Label>
            <Select
              value={trigger.conditionField || ""}
              onValueChange={handleFieldChange}
            >
              <SelectTrigger className="h-8 text-sm" data-testid={`select-trigger-field-${index}`}>
                <SelectValue placeholder="Feld wählen…" />
              </SelectTrigger>
              <SelectContent>
                {availableFields.map((f) => (
                  <SelectItem key={f.field} value={f.field}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedFieldDef && selectedFieldDef.valueType !== "boolean" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Operator</Label>
                <Select
                  value={trigger.conditionOperator}
                  onValueChange={(v) => onChange(index, { ...trigger, conditionOperator: v })}
                >
                  <SelectTrigger className="h-8 text-sm" data-testid={`select-trigger-operator-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedFieldDef.operators.map((op) => (
                      <SelectItem key={op} value={op}>
                        {TRIGGER_OPERATOR_LABELS[op as keyof typeof TRIGGER_OPERATOR_LABELS] || op}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Wert</Label>
                {selectedFieldDef.values ? (
                  <Select
                    value={trigger.conditionValue || ""}
                    onValueChange={(v) => onChange(index, { ...trigger, conditionValue: v })}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid={`select-trigger-value-${index}`}>
                      <SelectValue placeholder="Wert wählen…" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedFieldDef.values.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="h-8 text-sm"
                    value={trigger.conditionValue || ""}
                    onChange={(e) => onChange(index, { ...trigger, conditionValue: e.target.value })}
                    placeholder="Wert eingeben"
                    data-testid={`input-trigger-value-${index}`}
                  />
                )}
              </div>
            </>
          )}

          {selectedFieldDef && selectedFieldDef.valueType === "boolean" && (
            <div className="col-span-2 flex items-end pb-1">
              <span className="text-xs text-gray-500 italic">→ ist aktiv / wahr</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DocumentTypesContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingType, setEditingType] = useState<DocumentTypeData | null>(null);
  const [formData, setFormData] = useState<DocTypeFormData>(emptyForm);
  const [filterTarget, setFilterTarget] = useState<string>("all");
  const [triggers, setTriggers] = useState<TriggerData[]>([]);
  const [triggersLoaded, setTriggersLoaded] = useState(false);

  const { data: docTypes, isLoading } = useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeData[]>("/admin/document-types?includeInactive=true");
      return unwrapResult(result);
    },
  });

  const { data: editTriggers } = useQuery<TriggerData[]>({
    queryKey: ["admin", "document-type-triggers", editingType?.id],
    queryFn: async () => {
      if (!editingType) return [];
      const result = await api.get<TriggerData[]>(`/admin/document-types/${editingType.id}/triggers`);
      return unwrapResult(result);
    },
    enabled: !!editingType,
  });

  useEffect(() => {
    if (editTriggers && !triggersLoaded) {
      setTriggers(editTriggers);
      setTriggersLoaded(true);
    }
  }, [editTriggers, triggersLoaded]);

  const createMutation = useMutation({
    mutationFn: async (data: ReturnType<typeof toPayload>) => {
      const result = await api.post<DocumentTypeData>("/admin/document-types", data);
      return unwrapResult(result);
    },
    onSuccess: async (newDocType) => {
      if (triggers.length > 0 && newDocType && typeof newDocType === 'object' && 'id' in newDocType) {
        const dt = newDocType as DocumentTypeData;
        await api.put(`/admin/document-types/${dt.id}/triggers`, {
          triggers: triggers.map((t, i) => ({ ...t, sortOrder: i })),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "document-types"] });
      setIsCreateOpen(false);
      setFormData(emptyForm);
      setTriggers([]);
      toast({ title: "Dokumententyp erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: ReturnType<typeof toPayload> & { id: number }) => {
      const [docResult] = await Promise.all([
        api.patch(`/admin/document-types/${id}`, data),
        api.put(`/admin/document-types/${id}/triggers`, {
          triggers: triggers.map((t, i) => ({ ...t, sortOrder: i })),
        }),
      ]);
      return unwrapResult(docResult);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "document-types"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "document-type-triggers"] });
      setEditingType(null);
      setFormData(emptyForm);
      setTriggers([]);
      setTriggersLoaded(false);
      toast({ title: "Dokumententyp aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenCreate = () => {
    setFormData(emptyForm);
    setTriggers([]);
    setTriggersLoaded(false);
    setIsCreateOpen(true);
  };

  const handleOpenEdit = (dt: DocumentTypeData) => {
    setFormData(toFormData(dt));
    setTriggers([]);
    setTriggersLoaded(false);
    setEditingType(dt);
  };

  const handleSubmit = () => {
    const payload = toPayload(formData);
    if (editingType) {
      updateMutation.mutate({ ...payload, id: editingType.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleCloseEdit = () => {
    setEditingType(null);
    setFormData(emptyForm);
    setTriggers([]);
    setTriggersLoaded(false);
  };

  const handleCloseCreate = (open: boolean) => {
    if (!open) {
      setTriggers([]);
      setTriggersLoaded(false);
    }
    setIsCreateOpen(open);
  };

  const handleTriggerChange = useCallback((index: number, updated: TriggerData) => {
    setTriggers((prev) => prev.map((t, i) => (i === index ? updated : t)));
  }, []);

  const handleTriggerRemove = useCallback((index: number) => {
    setTriggers((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddTrigger = () => {
    setTriggers((prev) => [...prev, createEmptyTrigger(formData.targetType)]);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const filteredDocTypes = docTypes?.filter(dt => 
    filterTarget === "all" || dt.targetType === filterTarget
  );

  const SectionHeader = ({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) => (
    <div className="flex items-start gap-2 pb-1">
      <div className="mt-0.5 text-teal-600">{icon}</div>
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500">{subtitle}</p>}
      </div>
    </div>
  );

  const formContent = (
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
              onClick={handleAddTrigger}
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
                  onChange={handleTriggerChange}
                  onRemove={handleTriggerRemove}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <Button
        className={`w-full mt-3 ${componentStyles.btnPrimary}`}
        onClick={handleSubmit}
        disabled={isPending || !formData.name.trim()}
        data-testid="button-save-doctype"
      >
        {isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
        {editingType ? "Aktualisieren" : "Erstellen"}
      </Button>
    </div>
  );

  return (
    <>
          <div className="flex items-center justify-between gap-2 mb-4">
            <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
              <DialogTrigger asChild>
                <Button className="bg-teal-600 hover:bg-teal-700 shrink-0 ml-auto" onClick={handleOpenCreate} data-testid="button-create-doctype">
                  <Plus className={`${iconSize.sm} sm:mr-2`} />
                  <span className="hidden sm:inline">Neuer Typ</span>
                  <span className="sm:hidden">Neu</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Neuer Dokumententyp</DialogTitle>
                </DialogHeader>
                {formContent}
              </DialogContent>
            </Dialog>
          </div>

          <div className="flex gap-2 mb-4">
            {["all", "employee", "customer"].map((t) => (
              <Button
                key={t}
                variant={filterTarget === t ? "default" : "outline"}
                size="sm"
                className={filterTarget === t ? "bg-teal-600 hover:bg-teal-700" : "bg-white"}
                onClick={() => setFilterTarget(t)}
                data-testid={`filter-target-${t}`}
              >
                {t === "all" ? "Alle" : t === "employee" ? "Mitarbeiter" : "Kunden"}
              </Button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredDocTypes?.length === 0 && (
                <Card>
                  <CardContent className="p-6 text-center text-gray-500">
                    {filterTarget === "all" 
                      ? "Noch keine Dokumententypen definiert. Erstellen Sie den ersten Typ."
                      : `Keine Dokumententypen für ${filterTarget === "employee" ? "Mitarbeiter" : "Kunden"} gefunden.`
                    }
                  </CardContent>
                </Card>
              )}
              {filteredDocTypes?.map((dt) => (
                <Card key={dt.id} className={!dt.isActive ? "opacity-60" : ""} data-testid={`card-doctype-${dt.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <FileCheck2 className={`${iconSize.sm} text-amber-600 shrink-0`} />
                          <span className="font-semibold text-gray-900">{dt.name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                            dt.targetType === "customer" 
                              ? "bg-blue-100 text-blue-700" 
                              : "bg-purple-100 text-purple-700"
                          }`}>
                            {dt.targetType === "customer" ? (
                              <><User className="h-3 w-3" /> Kunde</>
                            ) : (
                              <><Users className="h-3 w-3" /> Mitarbeiter</>
                            )}
                          </span>
                          {dt.isMandatory && (
                            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 inline-flex items-center gap-1">
                              <Shield className="h-3 w-3" /> Pflicht
                            </span>
                          )}
                          {!dt.isActive && (
                            <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">Inaktiv</span>
                          )}
                        </div>
                        {dt.description && (
                          <p className="text-sm text-gray-500 mb-2 ml-6">{dt.description}</p>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 ml-6">
                          <span className="text-xs text-gray-500 flex items-center gap-1">
                            {dt.inputMethod === "info" ? (
                              <><Info className="h-3 w-3 text-blue-500" /> Zur Kenntnisnahme</>
                            ) : dt.inputMethod === "signature" ? (
                              <><PenTool className="h-3 w-3" /> Digitale Unterschrift</>
                            ) : dt.inputMethod === "both" ? (
                              <><FileText className="h-3 w-3" /> Upload oder Unterschrift</>
                            ) : dt.hasTemplate ? (
                              <><FileText className="h-3 w-3 text-teal-600" /> Digitale Vorlage: {dt.templateName}</>
                            ) : (
                              <><Upload className="h-3 w-3" /> Nur Upload</>
                            )}
                          </span>
                          {dt.context !== "beide" && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                              {CONTEXT_OPTIONS.find(c => c.value === dt.context)?.label || dt.context}
                            </span>
                          )}
                          {dt.renewalDays && (
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <RotateCcw className="h-3 w-3" />
                              Wiedervorlage: {dt.renewalDays} Tage
                            </span>
                          )}
                          {dt.reviewIntervalMonths ? (
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <CalendarClock className="h-3 w-3" />
                              Prüfung alle {dt.reviewIntervalMonths} Monate
                            </span>
                          ) : (
                            <span className="text-xs text-gray-500">Keine Prüffrist</span>
                          )}
                          {dt.reviewIntervalMonths && dt.reminderLeadTimeDays && (
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <Bell className="h-3 w-3" />
                              {dt.reminderLeadTimeDays} {dt.reminderLeadTimeDays === 1 ? 'Tag' : 'Tage'} Vorlauf
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 shrink-0"
                        onClick={() => handleOpenEdit(dt)}
                        data-testid={`button-edit-doctype-${dt.id}`}
                      >
                        <Pencil className={`${iconSize.sm} text-gray-600`} />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

      <Dialog open={!!editingType} onOpenChange={() => handleCloseEdit()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Dokumententyp bearbeiten</DialogTitle>
          </DialogHeader>
          {formContent}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminDocumentTypes() {
  return (
    <Layout variant="admin">
      <DocumentTypesContent />
    </Layout>
  );
}
