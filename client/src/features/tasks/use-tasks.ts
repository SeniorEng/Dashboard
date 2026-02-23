import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { Task } from "@shared/schema";

export interface TaskWithRelations extends Task {
  createdBy: { id: number; displayName: string } | null;
  assignedTo: { id: number; displayName: string } | null;
  customer: { id: number; name: string } | null;
}

export function useTasks(options: { includeCompleted?: boolean; all?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.includeCompleted) params.append("includeCompleted", "true");
  if (options.all) params.append("all", "true");
  const queryString = params.toString();

  return useQuery<TaskWithRelations[]>({
    queryKey: ["tasks", options],
    queryFn: async () => {
      const result = await api.get<TaskWithRelations[]>(`/tasks${queryString ? `?${queryString}` : ""}`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      title: string;
      description?: string;
      dueDate?: string;
      priority?: "low" | "medium" | "high";
      assignedToUserId?: number;
      customerId?: number;
    }) => {
      const result = await api.post<Task>("/tasks", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: {
      id: number;
      title?: string;
      description?: string;
      dueDate?: string;
      priority?: "low" | "medium" | "high";
      status?: "open" | "in-progress" | "completed";
      assignedToUserId?: number;
      customerId?: number;
    }) => {
      const result = await api.patch<Task>(`/tasks/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/tasks/${id}`);
      unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useToggleTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, currentStatus }: { id: number; currentStatus: string }) => {
      const newStatus = currentStatus === "completed" ? "open" : "completed";
      const result = await api.patch<Task>(`/tasks/${id}`, { status: newStatus });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

