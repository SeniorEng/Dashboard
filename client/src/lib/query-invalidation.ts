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
    ["budget-rebook-preview"],
    ["budget-cost-estimate"],
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

/**
 * Domains whose query keys follow the `[domain-key, customerId, ...rest]`
 * structure. When `invalidateRelated` receives `{ customerId }`, only these
 * domains have the scope appended to their keys; other domains keep their
 * broad invalidation.
 */
const CUSTOMER_SCOPED_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([
  "budget",
]);

export type InvalidateOptions = { customerId?: number };

/**
 * Invalidate TanStack Query caches for one or more domains, plus their
 * directly related domains.
 *
 * IMPORTANT: `RELATED_DOMAINS` is intentionally **non-transitive**. If
 * domain A relates to B and B relates to C, calling `invalidateRelated(qc, "A")`
 * will NOT invalidate C. Every caller must list every domain it actually
 * touches. This keeps the fan-out predictable and avoids accidental cascades
 * (e.g. an appointment mutation should not invalidate billing just because
 * billing happens to relate to appointments downstream).
 *
 * Optional scope: pass `{ customerId }` as the last argument to restrict
 * invalidation of `CUSTOMER_SCOPED_DOMAINS` (currently: `budget`) to a single
 * customer's keys (`["budget-overview", customerId]` instead of the broad
 * `["budget-overview"]` prefix). Non-scoped domains still get broad
 * invalidation.
 *
 *   invalidateRelated(qc, "budget", { customerId: 42 });
 *   invalidateRelated(qc, "customers", "budget", { customerId: 42 });
 */
type InvalidateArg = Domain | InvalidateOptions;

export function invalidateRelated(
  queryClient: QueryClient,
  ...args: InvalidateArg[]
): void {
  const domains: Domain[] = [];
  let options: InvalidateOptions = {};
  for (const arg of args) {
    if (typeof arg === "string") {
      domains.push(arg);
    } else if (arg && typeof arg === "object") {
      options = { ...options, ...arg };
    }
  }

  type Entry = { key: string[]; domain: Domain };
  const toInvalidate = new Map<string, Entry>();

  const addKeysFor = (domain: Domain) => {
    const keys = DOMAIN_QUERY_KEYS[domain];
    if (!keys) return;
    for (const key of keys) {
      toInvalidate.set(`${domain}:${JSON.stringify(key)}`, { key, domain });
    }
  };

  for (const domain of domains) {
    addKeysFor(domain);
    const related = RELATED_DOMAINS[domain];
    if (related) {
      for (const relDomain of related) {
        addKeysFor(relDomain);
      }
    }
  }

  for (const { key, domain } of toInvalidate.values()) {
    if (
      options.customerId !== undefined &&
      CUSTOMER_SCOPED_DOMAINS.has(domain)
    ) {
      queryClient.invalidateQueries({
        queryKey: [...key, options.customerId],
      });
    } else {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }
}
