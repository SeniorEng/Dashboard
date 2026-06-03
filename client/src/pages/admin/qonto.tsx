import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { iconSize, componentStyles } from "@/design-system";
import { ArrowLeft } from "lucide-react";
import { StatusTab, TransactionsTab, AdvicesTab } from "@/features/qonto";
import type { Tab, MatchFilter } from "@/features/qonto";
import { useQontoStatus } from "@/features/qonto";

export default function AdminQonto() {
  const [tab, setTab] = useState<Tab>("status");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("all");

  const statusQuery = useQontoStatus();

  const tabs: { id: Tab; label: string }[] = [
    { id: "status", label: "Verbindung" },
    { id: "transactions", label: "Transaktionen" },
    { id: "advices", label: "Avise" },
  ];

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle}>Zahlungen & Qonto</h1>
          <p className="text-sm text-gray-600">Zahlungseingänge, Rechnungsabgleich und Avise</p>
        </div>
      </div>

      <div className="flex gap-1.5 mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-teal-50 text-teal-700 border border-teal-200"
                : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
            }`}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "status" && <StatusTab status={statusQuery.data} isLoading={statusQuery.isLoading} />}
      {tab === "transactions" && (
        <TransactionsTab
          configured={statusQuery.data?.configured ?? false}
          matchFilter={matchFilter}
          onFilterChange={setMatchFilter}
        />
      )}
      {tab === "advices" && <AdvicesTab />}
    </Layout>
  );
}
