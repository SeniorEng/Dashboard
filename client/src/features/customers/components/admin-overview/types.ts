import type { CustomerDetail } from "@/lib/api/types";

export interface SectionProps {
  customer: CustomerDetail;
  customerId: number;
  editingSection: string | null;
  setEditingSection: (section: string | null) => void;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  invalidateCustomer: () => void;
}
