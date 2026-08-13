import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { iconSize } from "@/design-system";
import {
  Loader2,
  FileText,
  FilePlus,
  CheckCircle2,
  ClipboardList,
  ChevronDown,
  CalendarClock,
} from "lucide-react";
import type { BillingCustomerItem } from "@shared/api";
import type { MissingSignatureItem } from "../types";
import { formatEuroDE } from "@shared/utils/money";
import {
  isPartiallyDocumented,
  isServiceRecordMissing,
  classifyBillingMaturity,
  isLateSignedFollowUp,
  lateSignedFollowUpCount,
  isAwaitingCustomerSignature,
  BILLING_BLOCK_SHORT_LABELS,
} from "@shared/domain/billing-eligibility";
import { BILLING_TYPE_LABELS } from "../constants";
import { getCustomerName } from "../utils";
import { useRowCap } from "../hooks/use-row-cap";
import type { Selection } from "../hooks/use-selection";

/**
 * Task #1905 — Schalter für die optische Kennzeichnung des PLAN-Anteils
 * („vorläufig"). Der Betrag einer Zeile/Gruppe ist IST + PLAN; ist der Schalter
 * an, wird ein Betrag mit PLAN-Anteil zusätzlich als vorläufig markiert.
 *
 * AN — und zwar tragend, nicht kosmetisch: PLAN wird bewusst KONSERVATIV
 * gerechnet (keine spekulative USt-Reklassifizierung, weil die Topf-Lage zum
 * Abrechnungszeitpunkt noch offen ist). Diese Entscheidung trägt nur, solange
 * der Prognose-Anteil auch als solcher erkennbar ist. Ohne die Kennzeichnung
 * stünde ein bewusst unscharfer Wert als blanker Euro-Betrag neben dem IST, das
 * exakt der späteren Rechnungssumme entspricht.
 *
 * Bewusst EINE Konstante, damit das Ein-/Ausschalten eine Zeile bleibt und
 * weder Berechnung noch Feldnamen berührt.
 */
const SHOW_PROVISIONAL_MARKER = true;

/**
 * IST + PLAN eines Kunden (Brutto-Cent). PLAN ist Prognose, siehe `@shared/api`.
 *
 * `null` bedeutet NICHT BERECHENBAR (fehlender Katalogpreis) — das reicht die
 * Funktion durch, statt es zu 0 zu glätten: eine 0 in einer Geld-Spalte liest
 * sich wie „nichts offen" und wäre eine stille Falschaussage.
 */
function rowTotalCents(c: BillingCustomerItem): number | null {
  if (c.actualAmountCents === null || c.plannedAmountCents === null) return null;
  return (c.actualAmountCents ?? 0) + (c.plannedAmountCents ?? 0);
}

/** Summe einer Gruppe + ob darin ein nicht berechenbarer Betrag steckt. */
function groupTotals(customers: BillingCustomerItem[]): {
  totalCents: number;
  plannedCents: number;
  hasUnknown: boolean;
} {
  let totalCents = 0;
  let plannedCents = 0;
  let hasUnknown = false;
  for (const c of customers) {
    const row = rowTotalCents(c);
    if (row === null) {
      hasUnknown = true;
      continue;
    }
    totalCents += row;
    plannedCents += c.plannedAmountCents ?? 0;
  }
  return { totalCents, plannedCents, hasUnknown };
}

interface PendingInvoicesCardProps {
  customers: BillingCustomerItem[] | undefined;
  isLoading: boolean;
  onCreateForCustomer: (customerId: number) => void;
  // Task #1889 — termingenaue „fehlende Unterschrift nach Abschluss"-Einträge je
  // Kunde (ersetzt die separate obere Box). Wird unter dem jeweiligen Kunden in der
  // Liste gerendert, sodass die Unterschrift direkt nachgeholt werden kann.
  missingSignaturesByCustomer?: Map<number, MissingSignatureItem[]>;
  // Task #1888 — geteilte Auswahl-Hülle (#1376) für die Sammelaktion „Erstellen (N)".
  // NUR erstellbare Kunden („Bereit zum Abrechnen") sind auswählbar; die übrigen
  // Gruppen bleiben sichtbar, aber read-only.
  selection?: Selection;
  onCreateSelected?: () => void;
  createSelectedPending?: boolean;
}

// Task #1905: Eine einzelne Kundenzeile — für alle drei Gruppen dieselbe
// Komponente. Die Begründungs-Hinweise sind datengetrieben und werden in der
// Gruppe „Dokumentation ausstehend" über `showReasonNotes` abgeschaltet (dort
// erklärt die Sektion den Zustand bereits).
function PendingCustomerRow({
  customer: c,
  onCreateForCustomer,
  missingSignatures,
  selectable,
  selected,
  onToggleSelect,
  showReasonNotes,
}: {
  customer: BillingCustomerItem;
  onCreateForCustomer: (customerId: number) => void;
  // Task #1889 — „fehlende Unterschrift nach Abschluss"-Termine dieses Kunden.
  missingSignatures?: MissingSignatureItem[];
  // Task #1888 — Auswahl-Checkbox nur in erstellbaren („Bereit")-Zeilen.
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number, checked: boolean) => void;
  // Task #1905 — Inline-Begründungen („nur X/Y dokumentiert", „Kundenunterschrift
  // fehlt", „noch N geplante Termine", …) erklären, WARUM ein Kunde nicht bereit
  // ist. In der Gruppe „Dokumentation ausstehend" sagt das schon die Sektion —
  // dort bleiben sie weg (fachlich so entschieden). Die #1889-Unterschriften-Liste
  // ist davon NICHT betroffen: sie ist eine Handlungs-Möglichkeit (Unterschrift
  // nachholen), keine Cluster-Begründung.
  showReasonNotes: boolean;
}) {
  // Task #1885: Dokumentierte Termine, aber noch gar kein Leistungsnachweis
  // (`coveredAppointments === 0`). Gemeinsame SSoT `isServiceRecordMissing`.
  const serviceRecordMissing = isServiceRecordMissing(c);
  // Partial-Signing-Hinweis: weniger Termine durch einen aktiven
  // Leistungsnachweis abgedeckt als dokumentiert wurden. Gemeinsame SSoT-Regel
  // `isPartiallyDocumented` (@shared/domain/billing-eligibility), dieselbe, die
  // `/billing/eligible-customers` für den „nur X/Y dokumentiert"-Hinweis nutzt.
  // Task #1885: Bei ganz fehlendem LN (`covered === 0`) NICHT als „nur 0/N
  // dokumentiert" anzeigen — das ist der eigene „Leistungsnachweis fehlt"-Hinweis.
  const partial = isPartiallyDocumented(c) && !serviceRecordMissing;
  const openCount = c.openAppointments ?? 0;
  // Task #1813: Nachberechnung (spät unterschriebene Nachzügler) — der Kunde
  // hat im Monat bereits eine Rechnung UND weitere signierte Termine, die noch
  // nicht abgerechnet sind. Gemeinsame SSoT-Regel `isLateSignedFollowUp`
  // (@shared/domain/billing-eligibility), dieselbe, die der Vorschau-Dialog
  // nutzt. Neutrale Kennzeichnung (kein amber) — es ist KEIN Fehler und KEINE
  // Doppelabrechnung.
  const rowTotal = rowTotalCents(c);
  const followUp = isLateSignedFollowUp(c);
  const followUpCount = lateSignedFollowUpCount(c);
  // Task #1786: Kurz-Hinweis für unterschrifts-blockierte Zeilen (z.B.
  // „Kundenunterschrift fehlt"). Nur relevant, wenn keine offenen Termine mehr
  // anstehen (sonst dominiert der „noch X geplante Termine"-Vermerk) und der
  // Kunde nicht ohnehin über den Partial-Hinweis erklärt wird.
  //
  // Task #1878: Bei einem Pflegekassen-Kunden, der einen bereits abgerechneten
  // kundensignierten Termin UND weitere nur mitarbeiter-signierte Termine im
  // Monat hat (Fall „Bernd Funke"), meldet die Eligibilitäts-SSoT — spiegel-
  // bildlich zu `buildInvoiceDraft` — `already_billed`. Der wahre Grund für die
  // sichtbar gehaltene Zeile ist aber die fehlende Kundenunterschrift der
  // weiteren Termine. `isAwaitingCustomerSignature` (dieselbe SSoT, die den
  // Euro-Betrag der Übersicht speist) überstimmt das Label daher wahrheitsgemäß
  // auf „Kundenunterschrift fehlt".
  const awaitingSignature = isAwaitingCustomerSignature(c);
  // Task #1881 — Anzahl der auf Kundenunterschrift wartenden Termine
  // (abgedeckt, aber nicht abrechenbar-signiert). Liegt sie vor, wird sie an das
  // Kurz-Label gehängt („Kundenunterschrift fehlt (2 Termine)"), damit ein Admin
  // ohne Kontext den Umfang erkennt.
  const awaitingSignatureCount = Math.max(
    0,
    (c.coveredAppointments ?? 0) - (c.signedAppointmentCount ?? 0),
  );
  // Task #1883 (Punkt 6) — Der „Kundenunterschrift fehlt"-Hinweis MUSS auch bei
  // Mischkunden feuern, die insgesamt `eligible` sind (der signierte Teil ist
  // abrechenbar, aber weitere Termine warten noch auf die Kundenunterschrift, nur
  // `employee_signed`). Vorher war er auf `eligibility ≠ eligible` gegatet — dadurch
  // verschwand der 669-€-Fall (Funke) still unter „Bereit zum Abrechnen". Jetzt feuert
  // er unabhängig von der Eligibilität, sobald awaiting-signature-Termine vorliegen
  // (und weder offene Termine noch ein fehlender LN die Zeile dominieren).
  const showAwaitingSignatureNote =
    showReasonNotes && awaitingSignature && openCount === 0 && !serviceRecordMissing;
  const awaitingSignatureLabel = awaitingSignatureCount > 0
    ? `${BILLING_BLOCK_SHORT_LABELS.customer_signature_required} (${awaitingSignatureCount} ${awaitingSignatureCount === 1 ? "Termin" : "Termine"})`
    : BILLING_BLOCK_SHORT_LABELS.customer_signature_required;
  // Task #1881/#1885 — generisches Block-Label nur für die ÜBRIGEN Block-Gründe
  // (not_signed/no_appointments/already_billed) eines blockierten Kunden, wenn die
  // Zeile nicht bereits über den Awaiting-, Partial- oder „LN fehlt"-Hinweis erklärt
  // wird (keine zweite, widersprüchliche Begründung).
  const blockLabel =
    showReasonNotes && !serviceRecordMissing && !showAwaitingSignatureNote && openCount === 0 && !partial
      && c.eligibility.status !== "eligible" && c.eligibility.reason
      ? BILLING_BLOCK_SHORT_LABELS[c.eligibility.reason]
      : null;
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
      data-testid={`row-pending-customer-${c.id}`}
    >
      {/* Task #1888 — Auswahl-Checkbox (nur in erstellbaren Zeilen). */}
      {selectable && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={(v) => onToggleSelect?.(c.id, v === true)}
          className="shrink-0"
          data-testid={`checkbox-pending-${c.id}`}
          aria-label={`${getCustomerName(c)} auswählen`}
        />
      )}
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
        {showReasonNotes && partial && (
          <div
            className="mt-0.5 text-xs text-amber-700"
            data-testid={`text-pending-partial-${c.id}`}
          >
            Nur {c.coveredAppointments}/{c.completedAppointments} dokumentierte Termine im Leistungsnachweis
          </div>
        )}
        {showReasonNotes && serviceRecordMissing && (
          <div
            className="mt-0.5 text-xs text-amber-700"
            data-testid={`text-pending-ln-missing-${c.id}`}
          >
            Noch kein Leistungsnachweis — {c.completedAppointments} dokumentierte
            {c.completedAppointments === 1 ? "r Termin" : " Termine"}
          </div>
        )}
        {showAwaitingSignatureNote && (
          <div
            className="mt-0.5 text-xs text-amber-700"
            data-testid={`text-pending-awaiting-signature-${c.id}`}
          >
            {awaitingSignatureLabel}
          </div>
        )}
        {blockLabel && (
          <div
            className="mt-0.5 text-xs text-amber-700"
            data-testid={`text-pending-block-${c.id}`}
          >
            {blockLabel}
          </div>
        )}
        {followUp && (
          <div
            className="mt-0.5 text-xs text-sky-700"
            data-testid={`text-pending-followup-${c.id}`}
          >
            Nachberechnung — {followUpCount} {followUpCount === 1 ? "Termin" : "Termine"} nachträglich unterschrieben
          </div>
        )}
        {/* Task #1889 — termingenaue „fehlende Unterschrift nach Abschluss"-Einträge
            direkt unter dem Kunden (ersetzt die separate obere Box). Der
            Monatsabschluss-Kontext bleibt als Hinweis erhalten; jeder Eintrag
            verlinkt den Termin, damit die Unterschrift direkt nachgeholt werden kann. */}
        {missingSignatures && missingSignatures.length > 0 && (
          <div className="mt-1 space-y-1" data-testid={`block-missing-signatures-${c.id}`}>
            <div className="text-xs text-amber-700">
              Monat abgeschlossen — Unterschrift weiterhin nachholbar:
            </div>
            {missingSignatures.map((m) => (
              <Link
                key={m.id}
                href={`/appointment/${m.id}`}
                className="flex items-center gap-2 rounded border border-amber-200 bg-white px-2 py-1 text-xs text-amber-700 hover:underline"
                data-testid={`link-missing-signature-${m.id}`}
              >
                <span className="font-medium">
                  {m.date.split("-").reverse().join(".")}
                  {m.scheduledStart ? ` ${m.scheduledStart.slice(0, 5)}` : ""}
                </span>
                <span className="ml-auto shrink-0 text-gray-400">{m.employeeName}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
      {/* Task #1905 — Betrag der Zeile = IST + PLAN. IST ist geleistete, noch
          nicht abgerechnete Arbeit (dieselbe SSoT wie die Erstellung), PLAN die
          Prognose der noch offenen Termine. Dadurch trägt JEDE Gruppe einen
          Betrag — die früheren „—" in den Nicht-Bereit-Gruppen entfielen nur
          deshalb, weil der alte Wert ausschließlich den abrechenbaren Teil kannte.
          „—" bleibt für den echten Nullfall (nichts zu zeigen). */}
      <div
        className="shrink-0 text-right text-sm tabular-nums"
        data-testid={`text-pending-amount-${c.id}`}
      >
        {rowTotal === null ? (
          // Nicht berechenbar (fehlender Katalogpreis). Bewusst KEINE Zahl: eine
          // 0 oder ein Teilbetrag wäre hier still falsch.
          <span
            className="text-amber-700"
            title="Betrag nicht berechenbar — für eine Dienstleistung dieses Kunden ist am Termindatum kein Preis hinterlegt. Bitte den Dienstleistungskatalog prüfen."
            data-testid={`text-pending-amount-unknown-${c.id}`}
          >
            ?
          </span>
        ) : rowTotal > 0 ? (
          <span
            className="font-medium text-gray-900"
            title={
              (c.plannedAmountCents ?? 0) > 0
                ? `davon ${formatEuroDE(c.plannedAmountCents ?? 0)} geplant (noch nicht geleistet)`
                : undefined
            }
          >
            {formatEuroDE(rowTotal)}
            {SHOW_PROVISIONAL_MARKER && (c.plannedAmountCents ?? 0) > 0 && (
              <span
                className="ml-1 text-xs font-normal text-gray-500"
                data-testid={`text-pending-provisional-${c.id}`}
              >
                vorl.
              </span>
            )}
          </span>
        ) : (
          <span className="text-gray-400" title="Kein Betrag im Zeitraum">—</span>
        )}
      </div>
      {/* Task #1905 — „Erstellen" erscheint, wenn es tatsächlich etwas
          abzurechnen gibt: mindestens ein Termin unter einem abrechenbar
          signierten Leistungsnachweis, der noch auf keiner Rechnung liegt. Das
          ist dieselbe Menge, die `buildInvoiceDraft` in Rechnung stellen würde.
          ERSETZT das frühere Flag pro Sektion (`canCreate`), das mit dem
          Zusammenlegen von „Leistungsnachweis fehlt noch" (nie abrechenbar) und
          „Wartet auf Kundenunterschrift" (Mischkunde mit abrechenbarem Teil) in
          EINE Gruppe nicht mehr aufgehen konnte: pauschal an hätte einen Knopf
          gezeigt, der nur scheitern kann, pauschal aus hätte dem Mischkunden die
          bewusste Teil-Abrechnung (#1883, mit Bestätigung) genommen. */}
      {(c.unbilledAppointmentCount ?? 0) > 0 && (
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
      )}
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
  missingSignaturesByCustomer,
  selectable = false,
  selection,
  testIdKey,
  showReasonNotes = true,
}: {
  title: string;
  icon: ReactNode;
  headerClassName: string;
  customers: BillingCustomerItem[];
  onCreateForCustomer: (customerId: number) => void;
  missingSignaturesByCustomer?: Map<number, MissingSignatureItem[]>;
  // Task #1888 — nur erstellbare Sektionen („Bereit zum Abrechnen") sind auswählbar.
  selectable?: boolean;
  selection?: Selection;
  testIdKey: string;
  // Task #1905 — siehe `PendingCustomerRow`: in „Dokumentation ausstehend" aus.
  showReasonNotes?: boolean;
}) {
  const { visible, showAll, setShowAll, hiddenCount, capped, total } =
    useRowCap(customers);
  // Task #1772: Jede Sektion ist einzeln einklappbar — die Überschrift dient
  // als Toggle, der Zähler bleibt auch im eingeklappten Zustand sichtbar.
  // Standard: aufgeklappt.
  const [open, setOpen] = useState(true);
  // Task #1905 — Cluster-Summe = Σ (IST + PLAN) der Kunden dieser Gruppe. Die
  // Summe wird GENAU HIER gebildet (eine Stelle, dieselbe wie die Auswahl-Summe
  // unten) — der Server liefert die beiden Beträge pro Kunde, nicht pro Gruppe.
  // „Bereit" und „Leistungsnachweis fehlt" tragen per Konstruktion nur IST (beide
  // Gruppen haben keine offenen Termine); „Dokumentation ausstehend" ist gemischt.
  const { totalCents: groupTotalCents, plannedCents: groupPlannedCents, hasUnknown } =
    groupTotals(customers);
  // Task #1888 — Gruppen-Auswahlzustand (alle/teils/keine) für die Header-Checkbox
  // „ganze Gruppe auswählen" (analog Cluster-Auswahl der Rechnungs-Liste).
  const groupIds = customers.map((c) => c.id);
  const selectedInGroup =
    selectable && selection ? groupIds.filter((id) => selection.has(id)).length : 0;
  const allSelected = selectedInGroup === groupIds.length && groupIds.length > 0;
  const someSelected = selectedInGroup > 0 && !allSelected;
  if (customers.length === 0) return null;
  return (
    <div className="mt-5 first:mt-0" data-testid={`section-pending-${testIdKey}`}>
      <div className="mb-1 flex items-center gap-2">
      {/* Task #1888 — Gruppen-Auswahl-Checkbox (nur in erstellbaren Sektionen). */}
      {selectable && selection && (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(v) => selection.toggleMany(groupIds, v === true)}
          className="shrink-0"
          data-testid={`checkbox-pending-group-${testIdKey}`}
          aria-label={`${title} — ganze Gruppe auswählen`}
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 text-left text-sm font-medium ${headerClassName}`}
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
        {/* Task #1905 — Cluster-Summe (analog „Avis ausstehend … €"). */}
        <span
          className="ml-auto text-xs font-semibold tabular-nums text-gray-900"
          data-testid={`text-pending-${testIdKey}-total`}
          title={
            groupPlannedCents > 0
              ? `davon ${formatEuroDE(groupPlannedCents)} geplant (noch nicht geleistet)`
              : undefined
          }
        >
          {groupTotalCents > 0 ? formatEuroDE(groupTotalCents) : "—"}
          {/* Mindestens ein Kunde der Gruppe ist nicht berechenbar — die Summe
              ist damit unvollständig und sagt das auch. */}
          {hasUnknown && (
            <span
              className="ml-1 font-normal text-amber-700"
              title="Mindestens ein Betrag in dieser Gruppe ist nicht berechenbar (fehlender Preis im Dienstleistungskatalog) — die Summe ist unvollständig."
              data-testid={`text-pending-${testIdKey}-incomplete`}
            >
              + ?
            </span>
          )}
          {SHOW_PROVISIONAL_MARKER && groupPlannedCents > 0 && (
            <span
              className="ml-1 text-xs font-normal text-gray-500"
              data-testid={`text-pending-${testIdKey}-provisional`}
            >
              vorl.
            </span>
          )}
        </span>
      </button>
      </div>
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
                missingSignatures={missingSignaturesByCustomer?.get(c.id)}
                selectable={selectable}
                selected={selection?.has(c.id)}
                onToggleSelect={selection?.toggle}
                showReasonNotes={showReasonNotes}
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
// Task #1905: dreigeteilt in „Bereit zum Abrechnen", „Dokumentation ausstehend"
// und „Leistungsnachweis fehlt" — ALLE Kunden bleiben sichtbar, nur nach Reife
// gruppiert.
export function PendingInvoicesCard({
  customers,
  isLoading,
  onCreateForCustomer,
  missingSignaturesByCustomer,
  selection,
  onCreateSelected,
  createSelectedPending,
}: PendingInvoicesCardProps) {
  // Task #1501: Karte einklappbar — der Kopf dient als Toggle, der Zähler bleibt
  // auch im eingeklappten Zustand sichtbar.
  // Task #1772: Standard beim Betreten der Seite ist eingeklappt.
  const [open, setOpen] = useState(false);

  const all = customers ?? [];
  // Task #1905 — DREI Gruppen statt fünf, über die EINE SSoT
  // `classifyBillingMaturity` (@shared/domain/billing-eligibility) — genau eine
  // Gruppe pro Kunde:
  //  1. „Bereit zum Abrechnen": vollständig dokumentiert UND vollständig
  //     signiert. Nachberechnungen bleiben hier.
  //  2. „Dokumentation ausstehend": noch offene Termine ODER nicht alle
  //     dokumentierten Termine in einem Leistungsnachweis erfasst.
  //  3. „Leistungsnachweis fehlt": vollständig dokumentiert, aber ohne gültigen
  //     (kundenseitig unterschriebenen) Nachweis.
  //
  // ERSETZT die frühere Fünf-Sektionen-Aufteilung. Tragend dabei: ein Kunde, der
  // noch auf eine Kundenunterschrift wartet, steht nicht mehr unter „Bereit" —
  // vorher tat er das und zeigte dort gleichzeitig inline „Kundenunterschrift
  // fehlt" (Widerspruch + Unterberechnungs-Risiko beim Erstellen).
  const documentationPendingCustomers: BillingCustomerItem[] = [];
  const proofPendingCustomers: BillingCustomerItem[] = [];
  const readyCustomers: BillingCustomerItem[] = [];
  for (const c of all) {
    switch (classifyBillingMaturity(c)) {
      case "documentation_pending":
        documentationPendingCustomers.push(c);
        break;
      case "proof_pending":
        proofPendingCustomers.push(c);
        break;
      case "ready":
        readyCustomers.push(c);
        break;
    }
  }

  // Task #1888 — nur „Bereit zum Abrechnen" ist auswählbar (die einzige tatsächlich
  // erstellbare Gruppe). Der `generate-all`-Guard schneidet ohnehin auf signierte
  // LNs — die Auswahl-Allowlist ist eine zusätzliche, engere Absicherung.
  const selectionEnabled = !!selection && readyCustomers.length > 0;
  const readyIds = readyCustomers.map((c) => c.id);
  const selectedReadyCount = selection ? readyIds.filter((id) => selection.has(id)).length : 0;
  const allReadySelected = selectedReadyCount === readyIds.length && readyIds.length > 0;
  // Task #1905 — Auswahl-Summe bleibt bewusst IST-only: sie beziffert, was die
  // Sammelaktion tatsächlich in Rechnung stellt. „Bereit"-Kunden haben ohnehin
  // keinen PLAN-Anteil (keine offenen Termine) — die Einschränkung ist die
  // Absicherung gegen den Fall, dass sich das je ändert.
  //
  // `null` (nicht berechenbar) wird NICHT zu 0 geglättet, sondern markiert die
  // Summe als unvollständig — analog zur Gruppensumme. Diese Zahl steht direkt
  // neben dem Sammel-Schreibknopf; sie stillschweigend zu klein zu zeigen wäre
  // genau die Falschaussage, die `rowTotalCents`/`groupTotals` verhindern.
  const selectedReady = selection
    ? readyCustomers.filter((c) => selection.has(c.id))
    : [];
  const selectedTotalCents = selectedReady.reduce(
    (s, c) => s + (c.actualAmountCents ?? 0),
    0,
  );
  const selectedHasUnknown = selectedReady.some((c) => c.actualAmountCents === null);

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
                {/* Task #1888 — Auswahl-Kopfzeile: „Alle auswählen" (nur erstellbare
                    „Bereit"-Kunden) + Sammelaktion „Erstellen (N)" über den
                    #1883-geschützten generate-all-Pfad. Nur sichtbar, wenn es
                    erstellbare Kunden gibt. */}
                {selectionEnabled && selection && (
                  <div
                    className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
                    data-testid="bar-pending-selection"
                  >
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <Checkbox
                        checked={allReadySelected}
                        onCheckedChange={(v) =>
                          v === true ? selection.setAll(readyIds) : selection.clear()
                        }
                        data-testid="checkbox-pending-select-all"
                        aria-label="Alle erstellbaren Kunden auswählen"
                      />
                      <span>Alle auswählen</span>
                    </label>
                    {selectedReadyCount > 0 && (
                      <span className="text-sm text-gray-600" data-testid="text-pending-selected-count">
                        {selectedReadyCount} ausgewählt · {formatEuroDE(selectedTotalCents)}
                        {selectedHasUnknown && (
                          <span
                            className="ml-1 text-amber-700"
                            title="Mindestens ein ausgewählter Betrag ist nicht berechenbar (fehlender Preis im Dienstleistungskatalog) — die Summe ist unvollständig."
                            data-testid="text-pending-selected-incomplete"
                          >
                            + ?
                          </span>
                        )}
                      </span>
                    )}
                    <Button
                      size="sm"
                      className="ml-auto bg-teal-600 hover:bg-teal-700 text-white"
                      disabled={selectedReadyCount === 0 || !!createSelectedPending}
                      onClick={() => onCreateSelected?.()}
                      data-testid="button-pending-create-selected"
                    >
                      {createSelectedPending ? (
                        <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                      ) : (
                        <FileText className={`${iconSize.sm} mr-1`} />
                      )}
                      Erstellen ({selectedReadyCount})
                    </Button>
                  </div>
                )}
                <PendingSection
                  title="Bereit zum Abrechnen"
                  icon={<CheckCircle2 className={`${iconSize.sm} text-green-600`} />}
                  headerClassName="text-green-700"
                  customers={readyCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  missingSignaturesByCustomer={missingSignaturesByCustomer}
                  selectable={selectionEnabled}
                  selection={selection}
                  testIdKey="ready"
                />
                {/* Task #1905 — die Sektion selbst ist die Begründung; die
                    Kundenzeilen bleiben ohne Inline-Detail (`showReasonNotes`). */}
                <PendingSection
                  title="Dokumentation ausstehend"
                  icon={<CalendarClock className={`${iconSize.sm} text-amber-600`} />}
                  headerClassName="text-amber-700"
                  customers={documentationPendingCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  missingSignaturesByCustomer={missingSignaturesByCustomer}
                  testIdKey="documentation"
                  showReasonNotes={false}
                />
                {/* Task #1905: vollständig dokumentiert, aber ohne gültigen
                    (kundensignierten) Nachweis. NICHT abrechenbar → keine
                    „Erstellen"-Aktion (canCreate=false). */}
                <PendingSection
                  title="Leistungsnachweis fehlt"
                  icon={<FilePlus className={`${iconSize.sm} text-amber-600`} />}
                  headerClassName="text-amber-700"
                  customers={proofPendingCustomers}
                  onCreateForCustomer={onCreateForCustomer}
                  missingSignaturesByCustomer={missingSignaturesByCustomer}
                  testIdKey="proof"
                />
              </>
            )}
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
