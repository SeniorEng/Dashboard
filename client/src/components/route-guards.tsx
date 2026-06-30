import { Redirect } from "wouter";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PageErrorBoundary } from "@/components/error-boundary";

// Geteilter Lade-Platzhalter für alle Route-Guards (eine Quelle, nicht je Guard
// dupliziert).
export function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
      <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
    </div>
  );
}

// Task #1512 — Lohn-/Auszahlungs-/Personalkosten-Daten pro Mitarbeiter sind
// ausnahmslos Superadmin-only. Diese Seiten (Lexware-Stundenübersicht,
// Profitabilität/Leistung) werden für normale Admins gar nicht erst gerendert,
// passend zur serverseitigen `requireWageDataAccess`-Schranke.
export function SuperAdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if (!user?.isSuperAdmin) {
    return <Redirect to="/" />;
  }

  return (
    <PageErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    </PageErrorBoundary>
  );
}
