import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { ContactSection } from "../admin-overview/contact-section";
import { EmployeeSection } from "../admin-overview/employee-section";
import { CareLevelSection } from "../admin-overview/care-level-section";
import { MedicalSection, SpecialFeaturesSection, DocumentDeliverySection } from "../admin-overview/details-sections";
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
      {/* Bei ALLEN Kunden, auch bei Selbstzahlern (Ticket 6hcgffPJWm57p72p):
          der Pflegegrad entscheidet über die Umsatzsteuer (§ 4 Nr. 16 g UStG)
          und muss deshalb sichtbar und korrigierbar sein. */}
      <CareLevelSection {...sectionProps} />
      <MedicalSection {...sectionProps} />
      <SpecialFeaturesSection {...sectionProps} />
      <DocumentDeliverySection {...sectionProps} />
    </div>
  );
}
