import type { QueryClient } from "@tanstack/react-query";

type Domain =
  | "appointments"
  | "time-entries"
  | "service-records"
  | "customers"
  | "budget"
  | "notifications"
  | "auth"
  | "prospects"
  | "tasks"
  | "appointment-series"
  | "employee-documents"
  | "employee-proofs"
  | "customer-service-prices"
  | "customer-insurance"
  | "customer-documents"
  | "profile"
  | "whatsapp"
  | "admin-users"
  | "admin-time-entries"
  | "billing"
  | "qonto"
  | "services"
  | "document-types"
  | "document-templates"
  | "birthday-cards"
  | "pending-proofs"
  | "contact-migration"
  | "insurance-providers";

const DOMAIN_QUERY_KEYS: Record<Domain, string[][]> = {
  appointments: [
    ["appointments"],
    ["appointment-counts"],
    ["appointment-coverage"],
    ["/api/appointments"],
    ["search"],
    ["/admin/employees/availability"],
  ],
  "time-entries": [
    ["time-entries"],
    ["time-overview"],
    ["month-closing"],
    ["month-closing-readiness"],
    ["month-closing-preview"],
    ["admin-month-closing-readiness"],
    ["open-tasks"],
  ],
  "service-records": [
    ["/api/service-records"],
    ["/api/service-records/check-period"],
    ["/api/service-records/pending"],
    ["/api/service-records/overview"],
    ["service-record"],
    ["service-records"],
  ],
  customers: [
    ["customers"],
    ["customer"],
    ["customer-details"],
    ["search"],
    ["admin", "customers"],
    ["admin-customers"],
    ["admin-customers-duplicates"],
  ],
  budget: [
    ["budget-overview"],
    ["budget-type-settings"],
    ["budget-transactions"],
    ["initial-balances"],
  ],
  notifications: [
    ["notifications"],
  ],
  auth: [
    ["auth", "me"],
    ["admin", "my-permissions"],
  ],
  prospects: [
    ["prospects"],
    ["prospect"],
    ["prospect-stats"],
    ["prospect-offer"],
    ["prospect-appointment-data"],
  ],
  tasks: [
    ["tasks"],
  ],
  "appointment-series": [
    ["appointment-series"],
  ],
  "employee-documents": [
    ["admin", "employees"],
    ["admin", "document-types"],
  ],
  "employee-proofs": [
    ["admin", "employee-proofs"],
    ["admin", "employee-document-requirements"],
  ],
  "customer-service-prices": [
    ["customer-service-prices"],
    ["customer-service-prices-future"],
    ["customer-service-prices-all"],
  ],
  "customer-insurance": [
    ["customer-insurance-history"],
  ],
  "customer-documents": [
    ["admin", "customers"],
    ["customers"],
  ],
  profile: [
    ["profile"],
    ["user"],
    ["profile-proofs"],
    ["profile-documents"],
    ["whatsapp-preferences"],
  ],
  whatsapp: [
    ["whatsapp", "rules"],
    ["whatsapp"],
  ],
  "admin-users": [
    ["admin", "users"],
    ["admin", "vacation-summaries"],
  ],
  "admin-time-entries": [
    ["admin-time-entries"],
    ["admin-month-closings"],
    ["admin-vacation-summary"],
  ],
  billing: [
    ["billing"],
    ["billing-invoices"],
    ["billing-invoice-detail"],
    ["billing-delivery-history"],
  ],
  qonto: [
    ["qonto"],
  ],
  services: [
    ["/api/services/all"],
    ["/api/services"],
    ["services"],
  ],
  "document-types": [
    ["admin", "document-types"],
    ["admin", "document-type-triggers"],
  ],
  "document-templates": [
    ["admin", "document-templates"],
  ],
  "birthday-cards": [
    ["birthday-cards"],
  ],
  "pending-proofs": [
    ["admin", "pending-proofs"],
  ],
  "contact-migration": [
    ["admin", "contact-migration", "legacy"],
  ],
  "insurance-providers": [
    ["insurance-providers"],
  ],
};

const RELATED_DOMAINS: Record<Domain, Domain[]> = {
  appointments: ["time-entries", "service-records", "budget", "customers", "notifications", "auth"],
  "time-entries": [],
  "service-records": ["appointments", "budget"],
  customers: ["appointments", "budget"],
  budget: ["customers"],
  notifications: [],
  auth: [],
  prospects: [],
  tasks: [],
  "appointment-series": ["appointments"],
  "employee-documents": ["employee-proofs"],
  "employee-proofs": ["employee-documents"],
  "customer-service-prices": [],
  "customer-insurance": ["customers"],
  "customer-documents": [],
  profile: ["auth"],
  whatsapp: [],
  "admin-users": [],
  "admin-time-entries": [],
  billing: ["qonto"],
  qonto: ["billing"],
  services: [],
  "document-types": [],
  "document-templates": [],
  "birthday-cards": [],
  "pending-proofs": ["employee-proofs"],
  "contact-migration": ["customers"],
  "insurance-providers": [],
};

export function invalidateRelated(
  queryClient: QueryClient,
  ...domains: Domain[]
): void {
  const toInvalidate = new Set<string>();

  for (const domain of domains) {
    const keys = DOMAIN_QUERY_KEYS[domain];
    if (keys) {
      for (const key of keys) {
        toInvalidate.add(JSON.stringify(key));
      }
    }

    const related = RELATED_DOMAINS[domain];
    if (related) {
      for (const relDomain of related) {
        const relKeys = DOMAIN_QUERY_KEYS[relDomain];
        if (relKeys) {
          for (const key of relKeys) {
            toInvalidate.add(JSON.stringify(key));
          }
        }
      }
    }
  }

  for (const keyStr of toInvalidate) {
    const queryKey = JSON.parse(keyStr);
    queryClient.invalidateQueries({ queryKey });
  }
}
