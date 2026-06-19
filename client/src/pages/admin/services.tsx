import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useServices, ServiceList, StandardPricingSection } from "@/features/services";

export default function AdminServices() {
  const { data: services, isLoading } = useServices();

  return (
    <Layout variant="admin">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className={componentStyles.pageTitle}>Dienstleistungskatalog</h1>
          </div>
          <p className="text-sm text-gray-600" data-testid="text-services-subtitle">
            Leistungskatalog (Identität nur lesbar) und firmenweite Standardpreise (mit Stichtag pflegbar)
          </p>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">Firmenweite Standardpreise</h2>
          <StandardPricingSection services={services} isLoading={isLoading} />
        </div>

        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">Leistungskatalog</h2>
          <ServiceList services={services} isLoading={isLoading} />
        </div>
      </div>
    </Layout>
  );
}
