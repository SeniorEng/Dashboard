export interface ServiceWithPots {
  id: number;
  code: string | null;
  name: string;
  description: string | null;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  minDurationMinutes: number | null;
  isActive: boolean;
  isDefault: boolean;
  isSystem: boolean;
  isBillable: boolean;
  employeeRateCents: number;
  lohnartKategorie: string;
  sortOrder: number;
  budgetPots: string[];
  createdAt: string;
}

export interface ServiceFormData {
  name: string;
  code: string;
  description: string;
  unitType: string;
  defaultPriceCents: string;
  vatRate: string;
  minDurationMinutes: string;
  isBillable: boolean;
  employeeRateCents: string;
  lohnartKategorie: string;
  budgetPots: string[];
  isDefault: boolean;
  isActive: boolean;
  sortOrder: string;
}
