import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { Customer } from "@shared/schema";

export type CustomerWithAccess = Customer & {
  isCurrentlyAssigned?: boolean;
};

export function useCustomerList(status?: string) {
  const queryStatus = status ?? "aktiv";
  return useQuery<CustomerWithAccess[]>({
    queryKey: ["customers", { status: queryStatus }],
    queryFn: async () => {
      const endpoint = queryStatus ? `/customers?status=${queryStatus}` : "/customers";
      const result = await api.get<CustomerWithAccess[]>(endpoint);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}
