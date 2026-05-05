import { Link, useRoute } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Construction } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";

const AREA_TITLES: Record<string, string> = {
  "revenue": "Umsatz-Dashboard",
  "customers": "Kunden-Dashboard",
  "hours": "Leistungs-Dashboard",
  "appointments-per-customer": "Termine je Kunde",
  "revenue-per-customer": "Umsatz je Kunde",
};

export default function StatisticsComingSoon() {
  const [, params] = useRoute<{ area: string }>("/admin/statistics/coming-soon/:area");
  const area = params?.area ?? "";
  const title = AREA_TITLES[area] ?? "Detail-Dashboard";

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/statistics?tab=cockpit-v2" data-testid="link-back-statistics">
          <Button variant="ghost" size="sm">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">{title}</h1>
          <p className="text-sm text-muted-foreground">Phase 3 der Statistik-Überarbeitung</p>
        </div>
      </div>

      <Card className="border-dashed border-2 border-amber-300 bg-amber-50/30" data-testid="coming-soon-card">
        <CardContent className="p-12 flex flex-col items-center text-center gap-4">
          <Construction className="w-12 h-12 text-amber-600" />
          <h2 className="text-xl font-semibold">Kommt in Phase 3</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Diese Detailansicht wird in der nächsten Phase der Statistik-Überarbeitung gebaut.
            Bis dahin findest du die wichtigsten Werte direkt im Cockpit.
          </p>
          <Link href="/admin/statistics?tab=cockpit-v2">
            <Button variant="outline" size="sm" data-testid="button-back-cockpit">Zurück zum Cockpit</Button>
          </Link>
        </CardContent>
      </Card>
    </Layout>
  );
}
