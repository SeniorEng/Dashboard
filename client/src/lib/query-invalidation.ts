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
  | "tasks";

const DOMAIN_QUERY_KEYS: Record<Domain, string[][]> = {
  appointments: [
    ["appointments"],
    ["appointment-counts"],
    ["appointment-coverage"],
    ["search"],
  ],
  "time-entries": [
    ["time-entries"],
    ["time-overview"],
    ["month-closing"],
    ["month-closing-readiness"],
    ["month-closing-preview"],
    ["open-tasks"],
  ],
  "service-records": [
    ["/api/service-records"],
    ["/api/service-records/check-period"],
    ["/api/service-records/pending"],
    ["/api/service-records/overview"],
    ["service-record"],
  ],
  customers: [
    ["customers"],
    ["search"],
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
  ],
  prospects: [
    ["prospects"],
    ["prospect-stats"],
  ],
  tasks: [
    ["tasks"],
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
