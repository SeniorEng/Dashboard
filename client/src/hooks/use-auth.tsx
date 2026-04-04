import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";

export interface User {
  id: number;
  email: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isEuRentner: boolean;
  employmentType: string;
  weeklyWorkDays: number;
  roles: string[];
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthState {
  user: User | null;
  availableServices: string[];
  adminPermissions: string[];
  isLoading: boolean;
  isAuthenticated: boolean;
  badgeCount: number;
  birthdayCount: number;
}

interface AuthContextType extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refetch: () => void;
  hasAdminPermission: (permissionKey: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function fetchCurrentUser(): Promise<{ user: User; availableServices: string[]; badgeCount?: number; birthdayCount?: number } | null> {
  const result = await api.get<{ user: User; availableServices: string[]; badgeCount?: number; birthdayCount?: number }>("/auth/me");
  if (!result.success) {
    if (result.error.code === 'UNAUTHORIZED' || result.error.message.includes('401') || result.error.message.includes('Nicht angemeldet')) {
      return null;
    }
    throw new Error(result.error.message);
  }
  return result.data;
}

async function loginRequest(email: string, password: string): Promise<{ user: User; availableServices: string[] }> {
  const result = await api.post("/auth/login", { email, password });
  return unwrapResult(result) as { user: User; availableServices: string[] };
}

async function logoutRequest(): Promise<void> {
  const result = await api.post("/auth/logout", {});
  if (!result.success && result.error.code !== 'UNAUTHORIZED') {
    unwrapResult(result);
  }
}

async function fetchAdminPermissions(): Promise<{ permissions: string[]; isSuperAdmin: boolean }> {
  const result = await api.get<{ permissions: string[]; isSuperAdmin: boolean }>("/admin/my-permissions");
  if (!result.success) {
    return { permissions: [], isSuperAdmin: false };
  }
  return result.data;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchCurrentUser,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const isAdmin = data?.user?.isAdmin ?? false;

  const { data: adminPermsData } = useQuery({
    queryKey: ["admin", "my-permissions"],
    queryFn: fetchAdminPermissions,
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      loginRequest(email, password),
    onSuccess: () => {
      invalidateRelated(queryClient, "auth");
    },
    onError: (error: Error) => {
      toast({
        title: "Fehler",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logoutRequest,
    onSuccess: () => {
      queryClient.setQueryData(["auth", "me"], null);
      queryClient.setQueryData(["admin", "my-permissions"], null);
      queryClient.clear();
    },
    onError: () => {
      queryClient.setQueryData(["auth", "me"], null);
      queryClient.setQueryData(["admin", "my-permissions"], null);
      queryClient.clear();
    },
  });

  const login = useCallback(
    async (email: string, password: string) => {
      await loginMutation.mutateAsync({ email, password });
    },
    [loginMutation]
  );

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync();
  }, [logoutMutation]);

  const adminPermissions = adminPermsData?.permissions ?? [];
  const isSuperAdmin = data?.user?.isSuperAdmin ?? adminPermsData?.isSuperAdmin ?? false;

  const hasAdminPermission = useCallback(
    (permissionKey: string): boolean => {
      if (isSuperAdmin) return true;
      return adminPermissions.includes(permissionKey);
    },
    [isSuperAdmin, adminPermissions]
  );

  const value: AuthContextType = {
    user: data?.user ?? null,
    availableServices: data?.availableServices ?? [],
    adminPermissions,
    isLoading,
    isAuthenticated: !!data?.user,
    badgeCount: data?.badgeCount ?? 0,
    birthdayCount: data?.birthdayCount ?? 0,
    login,
    logout,
    refetch,
    hasAdminPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

function useRequireAuth(): AuthContextType & { user: User } {
  const auth = useAuth();
  if (!auth.user) {
    throw new Error("User is not authenticated");
  }
  return auth as AuthContextType & { user: User };
}

export function canCreateHauswirtschaft(roles: string[], isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return roles.includes("hauswirtschaft") || roles.includes("alltagsbegleitung");
}

function canCreateAlltagsbegleitung(roles: string[], isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return roles.includes("alltagsbegleitung");
}

export function canCreateErstberatung(roles: string[], isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return roles.includes("erstberatung");
}

function canCreateKundentermin(roles: string[], isAdmin: boolean): boolean {
  return canCreateHauswirtschaft(roles, isAdmin);
}
