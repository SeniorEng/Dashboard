import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { iconSize } from "@/design-system";
import {
  Loader2,
  FileText,
  CheckCircle2,
  ClipboardList,
  ChevronDown,
} from "lucide-react";
import type { BillingCustomerItem } from "@shared/api";
import { BILLING_TYPE_LABELS } from "../constants";
import { getCustomerName } from "../utils";
import { useRowCap } from "../hooks/use-row-cap";

interface PendingInvoicesCardProps {
  customers: BillingCustomerItem[] | undefined;
  isLoading: boolean;
  onCreateForCustomer: (customerId: number) => void;
}

// Task #1398: Zeigt direkt auf der Abrechnungsseite, welche Kunden für den
// gewählten Zeitraum noch eine Rechnung benötigen (berechtigt = mit
// unterschriebenem Leistungsnachweis, aber ohne Rechnung). Nutzt dieselbe
// Datenquelle (`useEligibleCustomers`) wie der `(N)`-Zähler und die
// Sammelaktion „Alle offenen erstellen", damit die Zahlen nie auseinanderlaufen.
export function PendingInvoicesCard({
  customers,
  isLoading,
  onCreateForCustomer,
}: PendingInvoicesCardProps) {
  // Task #1465: lange Kundenliste begrenzen — reine Darstellung; der `(N)`-Zähler
  // oben nutzt weiterhin `customers.length` (volle Datenbasis).
  const { visible, showAll, setShowAll, hiddenCount, capped, total } = useRowCap(
    customers ?? [],
  );
  // Task #1501: Karte einklappbar — der Kopf dient als Toggle, der Zähler bleibt
  // auch im eingeklappten Zustand sichtbar. Standard: aufgeklappt.
  const [open, setOpen] = useState(true);
  return (
    <Card className="mb-6" data-testid="card-pending-invoices">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex w-full items-center gap-2 text-left"
            data-testid="button-pending-toggle"
          >
            <ChevronDown
              className={`${iconSize.sm} flex-shrink-0 text-gray-400 transition-transform ${
                open ? "" : "-rotate-90"
              }`}
            />
            <ClipboardList className={`${iconSize.sm} text-teal-600`} />
            Noch zu erstellen
            {customers && customers.length > 0 && (
              <span
                className="ml-1 inline-flex items-center justify-center rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 border border-teal-200"
                data-testid="text-pending-count"
              >
                {customers.length}
              </span>
            )}
          </button>
        </CardTitle>
      </CardHeader>
      {open && (
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
            Wird geladen...
          </div>
        ) : !customers || customers.length === 0 ? (
          <div
            className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700"
            data-testid="text-pending-empty"
          >
            <CheckCircle2 className={`${iconSize.sm} flex-shrink-0`} />
            Für diesen Zeitraum ist alles abgerechnet.
          </div>
        ) : (
          <>
          <ul className="divide-y divide-gray-100">
            {visible.map((c) => {
              // Partial-Signing-Hinweis: weniger Termine durch einen aktiven
              // Leistungsnachweis abgedeckt als dokumentiert wurden.
              const partial =
                c.completedAppointments > 0 &&
                c.coveredAppointments < c.completedAppointments;
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                  data-testid={`row-pending-customer-${c.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="font-medium text-gray-900 truncate"
                        data-testid={`text-pending-name-${c.id}`}
                      >
                        {getCustomerName(c)}
                      </span>
                      <span
                        className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                        data-testid={`text-pending-type-${c.id}`}
                      >
                        {BILLING_TYPE_LABELS[c.billingType] ?? c.billingType}
                      </span>
                      {c.status === "inaktiv" && (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                          inaktiv
                        </span>
                      )}
                    </div>
                    {partial && (
                      <div
                        className="mt-0.5 text-xs text-amber-700"
                        data-testid={`text-pending-partial-${c.id}`}
                      >
                        Nur {c.coveredAppointments}/{c.completedAppointments} dokumentierte Termine im Leistungsnachweis
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-teal-700 border-teal-200 hover:bg-teal-50"
                    onClick={() => onCreateForCustomer(c.id)}
                    data-testid={`button-create-pending-${c.id}`}
                  >
                    <FileText className={`${iconSize.sm} mr-1`} />
                    Erstellen
                  </Button>
                </li>
              );
            })}
          </ul>
          {capped && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
                data-testid="button-pending-show-more"
              >
                {showAll
                  ? "Weniger anzeigen"
                  : `Alle ${total} anzeigen (${hiddenCount} weitere)`}
              </button>
            </div>
          )}
          </>
        )}
      </CardContent>
      )}
    </Card>
  );
}
