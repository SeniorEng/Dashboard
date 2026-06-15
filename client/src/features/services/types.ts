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
