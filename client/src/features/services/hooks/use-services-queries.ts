import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { ServiceWithPots } from "../types";

export function useServices() {
  return useQuery<ServiceWithPots[]>({
    queryKey: ["/api/services/all"],
    queryFn: async () => {
      const result = await api.get<ServiceWithPots[]>("/services/all");
      return unwrapResult(result);
    },
  });
}
