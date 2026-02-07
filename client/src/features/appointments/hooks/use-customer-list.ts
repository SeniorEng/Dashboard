import { useQuery } from "@tanstack/react-query";
import type { Customer } from "@shared/schema";

export type CustomerWithAccess = Customer & {
  isCurrentlyAssigned?: boolean;
};

export function useCustomerList() {
  return useQuery<CustomerWithAccess[]>({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await fetch("/api/customers");
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
    staleTime: 30000,
  });
}
