import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { ContactSection } from "./customer-overview/contact-section";
import { EmployeeSection } from "./customer-overview/employee-section";
import { CareLevelSection } from "./customer-overview/care-level-section";
import { MedicalSection, SpecialFeaturesSection, DocumentDeliverySection } from "./customer-overview/details-sections";
import type { CustomerDetail } from "@/lib/api/types";

interface CustomerOverviewTabProps {
  customer: CustomerDetail;
  customerId: number;
}

export function CustomerOverviewTab({ customer, customerId }: CustomerOverviewTabProps) {
  const queryClient = useQueryClient();
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const invalidateCustomer = () => {
    invalidateRelated(queryClient, "customers");
  };

  const sectionProps = {
    customer,
    customerId,
    editingSection,
    setEditingSection,
    saving,
    setSaving,
    invalidateCustomer,
  };

  return (
    <div className="space-y-4">
      <ContactSection {...sectionProps} />
      <EmployeeSection {...sectionProps} />
      <CareLevelSection {...sectionProps} />
      <MedicalSection {...sectionProps} />
      <SpecialFeaturesSection {...sectionProps} />
      <DocumentDeliverySection {...sectionProps} />
    </div>
  );
}
