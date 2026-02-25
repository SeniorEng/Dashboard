import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

type UnauthorizedBehavior = "returnNull" | "throw";
function getQueryFn<T>({ on401: unauthorizedBehavior }: {
  on401: UnauthorizedBehavior;
}): QueryFunction<T> {
  return async ({ queryKey }) => {
    const url = (queryKey.join("/") as string);
    const endpoint = url.startsWith("/api") ? url.slice(4) : url;
    const result = await api.get<T>(endpoint);

    if (!result.success) {
      if (unauthorizedBehavior === "returnNull" &&
          (result.error.code === 'UNAUTHORIZED' || result.error.message.includes('Nicht angemeldet'))) {
        return null as T;
      }
      throw new Error(result.error.message);
    }
    return result.data;
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 2 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
    },
    mutations: {
      retry: false,
    },
  },
});
