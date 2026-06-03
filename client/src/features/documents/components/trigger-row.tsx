import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { TRIGGER_OPERATOR_LABELS } from "@shared/schema/documents";
import {
  getTriggerFieldsForEntityType,
  getTriggerFieldDefinition,
} from "@shared/domain/document-triggers";
import type { TriggerData } from "../types";

export function TriggerRow({
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
