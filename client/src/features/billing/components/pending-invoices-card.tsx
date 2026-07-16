import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { iconSize } from "@/design-system";
import {
  Loader2,
  FileText,
  CheckCircle2,
  ClipboardList,
  ChevronDown,
  CalendarClock,
  ChevronRight,
  PenLine,
} from "lucide-react";
import type { BillingCustomerItem } from "@shared/api";
import { isPartiallyDocumented, hasOpenAppointments } from "@shared/domain/billing-eligibility";
import { BILLING_TYPE_LABELS } from "../constants";
import { getCustomerName } from "../utils";
import { useRowCap } from "../hooks/use-row-cap";

interface PendingInvoicesCardProps {
  customers: BillingCustomerItem[] | undefined;
  isLoading: boolean;
  onCreateForCustomer: (customerId: number) => void;
  // Task #1744: gewählter Abrechnungsmonat/-jahr, damit der Absprung „noch X
  // geplante Termine" die Kundendetail-Terminliste auf denselben Monat scopt.
  selectedMonth: number;
  selectedYear: number;
}

// Task #1743: Ein Kunde gilt als „bereit zum Abrechnen", wenn er im gewählten
// Monat KEINE offenen (geplanten) Termine mehr hat — sonst sollte man mit der
// Rechnung warten, bis alle Termine dokumentiert sind. Die Zahl der offenen
// Termine liefert der Server aus der `FINAL_APPOINTMENT_STATUSES`-SSoT
// (identisch zur Monatsabschluss-Readiness); die „offen?"-Regel selbst ist die
// gemeinsame SSoT `hasOpenAppointments` (@shared/domain/billing-eligibility),
// die auch der „Alle erstellen"-Dialog und der Server-`readyOnly`-Skip nutzen.

// Task #1743: Eine einzelne Kundenzeile. Der „noch X geplante Termine"-Hinweis
// ist datengetrieben (erscheint nur bei offenen Terminen), sodass beide
// Sektionen dieselbe Zeilenkomponente nutzen.
function PendingCustomerRow({
  customer: c,
  onCreateForCustomer,
  selectedMonth,
  selectedYear,
}: {
  customer: BillingCustomerItem;
  onCreateForCustomer: (customerId: number) => void;
  selectedMonth: number;
  selectedYear: number;
}) {
  // Partial-Signing-Hinweis: weniger Termine durch einen aktiven
  // Leistungsnachweis abgedeckt als dokumentiert wurden. Gemeinsame SSoT-Regel
  // `isPartiallyDocumented` (@shared/domain/billing-eligibility), dieselbe, die
  // `/billing/eligible-customers` für den „nur X/Y dokumentiert"-Hinweis nutzt.
  const partial = isPartiallyDocumented(c);
  const openCount = c.openAppointments ?? 0;
  return (
    <li
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
        {openCount > 0 && (
          <Link
            href={`/service-records/open?customerId=${c.id}&year=${selectedYear}&month=${selectedMonth}`}
            className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-amber-700 underline-offset-2 hover:text-amber-900 hover:underline"
            data-testid={`text-pending-open-note-${c.id}`}
          >
            noch {openCount} {openCount === 1 ? "geplanter Termin" : "geplante Termine"}
            <ChevronRight className={iconSize.xs} />
          </Link>
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
}

// Task #1743: Eine gruppierte Sektion („Bereit zum Abrechnen" bzw. „Noch offene
// Termine"). Kappt die Liste eigenständig (Task #1465) und blendet sich aus,
// wenn sie leer ist — so bleibt die Karte übersichtlich, wenn alle Kunden in
// eine der beiden Gruppen fallen.
function PendingSection({
  title,
  icon,
  headerClassName,
  customers,
  onCreateForCustomer,
  testIdKey,
  selectedMonth,
  selectedYear,
}: {
  title: string;
  icon: ReactNode;
  headerClassName: string;
  customers: BillingCustomerItem[];
  onCreateForCustomer: (customerId: number) => void;
  testIdKey: string;
  selectedMonth: number;
  selectedYear: number;
}) {
  const { visible, showAll, setShowAll, hiddenCount, capped, total } =
    useRowCap(customers);
  // Task #1772: Jede Sektion ist einzeln einklappbar — die Überschrift dient
  // als Toggle, der Zähler bleibt auch im eingeklappten Zustand sichtbar.
  // Standard: aufgeklappt.
  const [open, setOpen] = useState(true);
  if (customers.length === 0) return null;
  return (
    <div className="mt-5 first:mt-0" data-testid={`section-pending-${testIdKey}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className={`mb-1 flex w-full items-center gap-2 text-left text-sm font-medium ${headerClassName}`}
        data-testid={`button-pending-section-toggle-${testIdKey}`}
      >
        <ChevronDown
          className={`${iconSize.sm} flex-shrink-0 text-gray-400 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        {icon}
        <span>{title}</span>
        <span
          className="inline-flex items-center justify-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
          data-testid={`text-pending-${testIdKey}-count`}
        >
          {customers.length}
        </span>
      </button>
      {/* Task #1772: weiches Ein-/Ausklappen via grid-rows-Transition (kein
          CSS-Transform), analog zur Karte. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
        data-testid={`region-pending-section-${testIdKey}`}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {visible.map((c) => (
              <PendingCustomerRow
                key={c.id}
                customer={c}
                onCreateForCustomer={onCreateForCustomer}
                selectedMonth={selectedMonth}
                selectedYear={selectedYear}
              />
            ))}
          </ul>
          {capped && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
                data-testid={`button-pending-show-more-${testIdKey}`}
              >
                {showAll
                  ? "Weniger anzeigen"
                  : `Alle ${total} anzeigen (${hiddenCount} weitere)`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Task #1398: Zeigt direkt auf der Abrechnungsseite, welche Kunden für den
// gewählten Zeitraum noch eine Rechnung benötigen (berechtigt = mit
// unterschriebenem Leistungsnachweis, aber ohne Rechnung). Nutzt dieselbe
// Datenquelle (`useEligibleCustomers`) wie der `(N)`-Zähler und die
// Sammelaktion „Alle offenen erstellen", damit die Zahlen nie auseinanderlaufen.
// Task #1743: zweigeteilt in „Bereit zum Abrechnen" (keine offenen Termine mehr)
// und „Noch offene Termine" (im Monat sind noch Termine geplant/undokumentiert)
// — ALLE Kunden bleiben sichtbar, nur nach Reife gruppiert.
export function PendingInvoicesCard({
  customers,
  isLoading,
  onCreateForCustomer,
  selectedMonth,
  selectedYear,
}: PendingInvoicesCardProps) {
  // Task #1501: Karte einklappbar — der Kopf dient als Toggle, der Zähler bleibt
  // auch im eingeklappten Zustand sichtbar.
  // Task #1772: Standard beim Betreten der Seite ist eingeklappt.
  const [open, setOpen] = useState(false);

  const all = customers ?? [];
  // Task #1774: Reihenfolge der Reifegruppen —
  //  1. „Noch offene Termine": im Monat sind noch geplante Termine offen.
  //  2. „Wartet auf Kundenunterschrift": keine offenen Termine mehr, aber das
  //     kassen-/zahlerabhängige Unterschrifts-Gate ist NICHT erfüllt (Pflegekasse
  //     ohne Kundenunterschrift, nur `employee_signed`). Kommt aus DERSELBEN SSoT
  //     wie der Erstellungs-Pfad (`classifyBillingEligibility`), sodass Anzeige
  //     und tatsächliche Erstellung nicht auseinanderdriften.
  //  3. „Bereit zum Abrechnen": tatsächlich abrechenbar (eligible) UND keine
  //     offenen Termine mehr.
  const openCustomers = all.filter((c) => hasOpenAppointments(c));
  const notOpen = all.filter((c) => !hasOpenAppointments(c));
  const signatureBlockedCustomers = notOpen.filter(
    (c) => c.eligibility.reason === "customer_signature_required",
  );
  const readyCustomers = notOpen.filter(
    (c) => c.eligibility.status === "eligible",
  );

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
            {all.length > 0 && (
              <span
                className="ml-1 inline-flex items-center justify-center rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 border border-teal-200"
                data-testid="text-pending-count"
              >
                {all.length}
              </span>
            )}
          </button>
        </CardTitle>
      </CardHeader>
      {/* Task #1501: weiches Ein-/Ausklappen via grid-rows-Transition — Inhalt
          bleibt gemountet, daher keine harten Sprünge und kein CSS-Transform. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
        data-testid="region-pending-body"
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
                Wird geladen...
              </div>
            ) : all.length === 0 ? (
              <div
                className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700"
                data-testid="text-pending-empty"
              >
                <CheckCircle2 className={`${iconSize.sm} flex-shrink-0`} />
                Für diesen Zeitraum ist alles abgerechnet.
              </div>
            ) : (
              <>
                <PendingSection
                  title="Bereit zum Abrechnen"
                  icon={<CheckCircle2 className={`${iconSize.sm} text-green-600`} />}
                  headerClassName="text-green-700"
                  customers={readyCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  testIdKey="ready"
                  selectedMonth={selectedMonth}
                  selectedYear={selectedYear}
                />
                <PendingSection
                  title="Wartet auf Kundenunterschrift"
                  icon={<PenLine className={`${iconSize.sm} text-amber-600`} />}
                  headerClassName="text-amber-700"
                  customers={signatureBlockedCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  testIdKey="signature"
                  selectedMonth={selectedMonth}
                  selectedYear={selectedYear}
                />
                <PendingSection
                  title="Noch offene Termine"
                  icon={<CalendarClock className={`${iconSize.sm} text-amber-600`} />}
                  headerClassName="text-amber-700"
                  customers={openCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  testIdKey="open"
                  selectedMonth={selectedMonth}
                  selectedYear={selectedYear}
                />
              </>
            )}
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
