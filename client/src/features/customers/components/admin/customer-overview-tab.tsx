import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { ContactSection } from "../admin-overview/contact-section";
import { EmployeeSection } from "../admin-overview/employee-section";
import { CareLevelSection } from "../admin-overview/care-level-section";
import { MedicalSection, SpecialFeaturesSection, DocumentDeliverySection } from "../admin-overview/details-sections";
import { isPflegekasseCustomer } from "@shared/domain/customers";
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
      {isPflegekasseCustomer((customer.billingType ?? "") as "" | "pflegekasse_gesetzlich" | "pflegekasse_privat" | "selbstzahler") && (
        <CareLevelSection {...sectionProps} />
      )}
      <MedicalSection {...sectionProps} />
      <SpecialFeaturesSection {...sectionProps} />
      <DocumentDeliverySection {...sectionProps} />
    </div>
  );
}
