import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight, PenLine } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

interface MissingSignatureItem {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  employeeName: string;
  year: number;
  month: number;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function formatDate(isoDate: string): string {
  const parts = isoDate.split("-");
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Task #1504: „Fehlende Unterschriften nach Abschluss" — der wertvolle Rest der
// entfernten read-only Monatsabschluss-Seite, jetzt im Arbeitsplatz „Abrechnung".
// Rein abgeleitet aus der „Dokumentiert"-Stufe, gefiltert auf geschlossene
// Monate; Einträge verschwinden automatisch, sobald der Termin unterschrieben ist.
export function MissingSignaturesCard() {
  const { data } = useQuery<{ items: MissingSignatureItem[] }>({
    queryKey: ["month-closing-missing-signatures"],
    queryFn: async () =>
      unwrapResult(await api.get<{ items: MissingSignatureItem[] }>("/time-entries/month-closing/missing-signatures")),
    staleTime: 5 * 60 * 1000,
  });
  const missingSignatures = data?.items ?? [];
  const [collapsed, setCollapsed] = useState(true);

  if (missingSignatures.length === 0) return null;

  return (
    <Card className="mb-4 border-amber-200 bg-amber-50/40" data-testid="card-missing-signatures-after-close">
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="-m-1 flex w-full items-center gap-2 rounded p-1 text-left hover:bg-amber-100/40"
          data-testid="toggle-missing-signatures-after-close"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-amber-600 shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-amber-600 shrink-0" />
          )}
          <PenLine className="h-5 w-5 text-amber-600 shrink-0" />
          <h2 className="text-sm font-semibold text-amber-800">
            Fehlende Unterschriften nach Abschluss ({missingSignatures.length})
          </h2>
        </button>
        {!collapsed ? (
          <>
            <p className="text-xs text-gray-600 mt-3 mb-3">
              Diese Termine sind dokumentiert, der Monat ist bereits abgeschlossen, aber es
              fehlt noch die Unterschrift. Unterschrift weiterhin nachholbar — der Eintrag
              verschwindet automatisch, sobald unterschrieben wurde.
            </p>
            <div className="flex flex-col gap-1" data-testid="list-missing-signatures-after-close">
              {missingSignatures.map((item) => (
                <Link
                  key={item.id}
                  href={`/appointment/${item.id}`}
                  className="text-xs text-amber-700 hover:underline flex items-center gap-2 bg-white border border-amber-200 rounded px-2 py-1.5"
                  data-testid={`link-missing-signature-${item.id}`}
                >
                  <span className="font-medium">{formatDate(item.date)} {item.scheduledStart?.slice(0, 5)}</span>
                  <span className="truncate">{item.customerName}</span>
                  <span className="text-gray-400 ml-auto shrink-0">{item.employeeName}</span>
                  <span className="text-gray-400 shrink-0">{MONTH_NAMES[item.month - 1]} {item.year}</span>
                </Link>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
