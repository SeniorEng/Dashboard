import { useQuery } from "@tanstack/react-query";
import type { Customer } from "@shared/schema";

export type CustomerWithAccess = Customer & {
  isCurrentlyAssigned?: boolean;
};

export function useCustomerList(status?: string) {
  const queryStatus = status ?? "aktiv";
  return useQuery<CustomerWithAccess[]>({
    queryKey: ["customers", { status: queryStatus }],
    queryFn: async () => {
      const url = queryStatus ? `/api/customers?status=${queryStatus}` : "/api/customers";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
    staleTime: 30000,
  });
}
