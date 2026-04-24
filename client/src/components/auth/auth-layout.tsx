import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { colors, iconSize } from "@/design-system";
import {
  DEFAULT_BRAND_NAME,
  usePublicBranding,
} from "@/lib/public-branding";
import fallbackLogo from "@/assets/logo-seniorenengel.png";

interface AuthLayoutProps {
  children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div
      className={`min-h-screen flex items-center justify-center ${colors.surface.page} pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]`}
    >
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}

export function AuthLoadingScreen() {
  return (
    <div
      className={`min-h-screen flex items-center justify-center ${colors.surface.page} pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`}
    >
      <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
    </div>
  );
}

interface AuthBrandingLogoProps {
  testId: string;
}

export function AuthBrandingLogo({ testId }: AuthBrandingLogoProps) {
  const { data: branding } = usePublicBranding();
  const remoteLogo = branding?.pdfLogoUrl || branding?.logoUrl || null;
  const [src, setSrc] = useState<string>(fallbackLogo);

  useEffect(() => {
    if (remoteLogo) setSrc(remoteLogo);
  }, [remoteLogo]);

  return (
    <img
      src={src}
      alt={branding?.companyName || DEFAULT_BRAND_NAME}
      className="h-28 w-auto mx-auto mb-4"
      data-testid={testId}
      onError={() => {
        if (src !== fallbackLogo) setSrc(fallbackLogo);
      }}
    />
  );
}
