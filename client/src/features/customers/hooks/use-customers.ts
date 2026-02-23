/**
 * Customer Hooks
 * 
 * React Query hooks for customer data fetching and mutations.
 * Uses the centralized API client for consistent error handling.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type {
  CustomerListItem,
  CustomerListParams,
  CustomerDetail,
  PaginatedResponse,
  CreateCustomerRequest,
} from "@/lib/api/types";

// Query keys for cache management
export const customerKeys = {
  all: ["customers"] as const,
  lists: () => [...customerKeys.all, "list"] as const,
  list: (params: CustomerListParams) => [...customerKeys.lists(), params] as const,
  details: () => [...customerKeys.all, "detail"] as const,
  detail: (id: number) => [...customerKeys.details(), id] as const,
};

/**
 * Build query string from params
 */
function buildQueryString(params: CustomerListParams): string {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set("page", params.page.toString());
  if (params.limit) searchParams.set("limit", params.limit.toString());
  if (params.search) searchParams.set("search", params.search);
  if (params.pflegegrad) searchParams.set("pflegegrad", params.pflegegrad);
  if (params.billingType) searchParams.set("billingType", params.billingType);
  if (params.primaryEmployeeId) searchParams.set("primaryEmployeeId", params.primaryEmployeeId);
  if (params.status) searchParams.set("status", params.status);
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch paginated customer list
 */
export function useCustomers(params: CustomerListParams = {}) {
  return useQuery({
    queryKey: customerKeys.list(params),
    queryFn: async ({ signal }) => {
      const queryString = buildQueryString(params);
      const result = await api.get<PaginatedResponse<CustomerListItem>>(
        `/admin/customers${queryString}`,
        signal
      );
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

/**
 * Fetch single customer details
 */
export function useCustomer(id: number) {
  return useQuery({
    queryKey: customerKeys.detail(id),
    queryFn: async ({ signal }) => {
      const result = await api.get<CustomerDetail>(
        `/admin/customers/${id}/details`,
        signal
      );
      return unwrapResult(result);
    },
    enabled: id > 0,
    staleTime: 30000,
  });
}

/**
 * Create new customer
 */
export function useCreateCustomer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateCustomerRequest) => {
      const result = await api.post<{ id: number }>("/admin/customers", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      toast({ title: "Erfolg", description: "Kunde wurde angelegt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Kunde konnte nicht angelegt werden", variant: "destructive" });
    },
  });
}

/**
 * Update customer
 */
export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<CreateCustomerRequest> }) => {
      const result = await api.patch<CustomerDetail>(`/admin/customers/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      toast({ title: "Erfolg", description: "Kundendaten wurden aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Kundendaten konnten nicht aktualisiert werden", variant: "destructive" });
    },
  });
}

/**
 * Delete customer
 */
export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete<void>(`/admin/customers/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      toast({ title: "Erfolg", description: "Kunde wurde deaktiviert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Kunde konnte nicht deaktiviert werden", variant: "destructive" });
    },
  });
}
