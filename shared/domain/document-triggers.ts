import type { TriggerOperator } from "@shared/schema/documents";

export interface TriggerFieldDefinition {
  field: string;
  label: string;
  entityType: "customer" | "employee";
  operators: TriggerOperator[];
  values?: Array<{ value: string; label: string }>;
  valueType: "select" | "boolean" | "number";
}

export const TRIGGER_FIELD_REGISTRY: TriggerFieldDefinition[] = [
  {
    field: "billingType",
    label: "Kundentyp",
    entityType: "customer",
    operators: ["equals"],
    valueType: "select",
    values: [
      { value: "pflegekasse_gesetzlich", label: "Pflegekasse (gesetzlich)" },
      { value: "pflegekasse_privat", label: "Pflegekasse (privat)" },
      { value: "selbstzahler", label: "Selbstzahler" },
    ],
  },
  {
    field: "pflegegrad",
    label: "Pflegegrad",
    entityType: "customer",
    operators: ["equals", "greater_than"],
    valueType: "number",
    values: [
      { value: "0", label: "0 (kein Pflegegrad)" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" },
      { value: "4", label: "4" },
      { value: "5", label: "5" },
    ],
  },
  {
    field: "haustierVorhanden",
    label: "Haustier vorhanden",
    entityType: "customer",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "personenbefoerderungGewuenscht",
    label: "Personenbeförderung gewünscht",
    entityType: "customer",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "acceptsPrivatePayment",
    label: "Akzeptiert Privatzahlung",
    entityType: "customer",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "hauswirtschaft",
    label: "Rolle: Hauswirtschaft",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "alltagsbegleitung",
    label: "Rolle: Alltagsbegleitung",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "erstberatung",
    label: "Rolle: Erstberatung",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "personenbefoerderung",
    label: "Rolle: Personenbeförderung",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "kinderbetreuung",
    label: "Rolle: Kinderbetreuung",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
  {
    field: "employmentType",
    label: "Beschäftigungsart",
    entityType: "employee",
    operators: ["equals"],
    valueType: "select",
    values: [
      { value: "minijobber", label: "Minijobber" },
      { value: "sozialversicherungspflichtig", label: "Sozialversicherungspflichtig" },
    ],
  },
  {
    field: "haustierAkzeptiert",
    label: "Akzeptiert Haustiere",
    entityType: "employee",
    operators: ["is_true"],
    valueType: "boolean",
  },
];

export function getTriggerFieldsForEntityType(entityType: "customer" | "employee"): TriggerFieldDefinition[] {
  return TRIGGER_FIELD_REGISTRY.filter((f) => f.entityType === entityType);
}

export function getTriggerFieldDefinition(field: string): TriggerFieldDefinition | undefined {
  return TRIGGER_FIELD_REGISTRY.find((f) => f.field === field);
}

export function getValuesForTriggerField(field: string): Array<{ value: string; label: string }> {
  const def = getTriggerFieldDefinition(field);
  return def?.values ?? [];
}
