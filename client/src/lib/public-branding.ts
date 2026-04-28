import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

interface PublicBranding {
  logoUrl: string | null;
  pdfLogoUrl: string | null;
  companyName: string | null;
}

export const DEFAULT_BRAND_NAME = "Senioren Engel";

const EMPTY_BRANDING: PublicBranding = {
  logoUrl: null,
  pdfLogoUrl: null,
  companyName: null,
};

const BRANDING_STALE_TIME_MS = 5 * 60 * 1000;

export function usePublicBranding() {
  return useQuery<PublicBranding>({
    queryKey: ["public-branding"],
    queryFn: async () => {
      const result = await api.get<PublicBranding>("/public/branding");
      if (!result.success) return EMPTY_BRANDING;
      return result.data;
    },
    staleTime: BRANDING_STALE_TIME_MS,
  });
}
