import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import type { Notification } from "@shared/schema";

export function useNotifications() {
  return useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const result = await api.get<Notification[]>("/notifications");
      return unwrapResult(result);
    },
    staleTime: 15000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useUnreadCount() {
  return useQuery<number>({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const result = await api.get<{ count: number }>("/notifications/unread-count");
      return unwrapResult(result).count;
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 10000,
  });
}

/**
 * Triggers an immediate refetch of notification queries when the tab becomes
 * visible again. Acceptance criterion AC5 (≤500 ms after tab focus).
 */
export function useNotificationVisibilityRefetch() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient]);
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.patch(`/notifications/${id}/read`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "notifications");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const result = await api.post("/notifications/mark-all-read", {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "notifications");
      toast({ title: "Erledigt", description: "Alle Benachrichtigungen als gelesen markiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}
