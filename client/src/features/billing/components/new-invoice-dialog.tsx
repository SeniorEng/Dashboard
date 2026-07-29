import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatEuroDE } from "@shared/utils/money";
import { iconSize } from "@/design-system";
import { Loader2, FileText, Ban } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  BillingCustomerItem,
  BillingInvoicePreview,
  BlockingDraftInvoice,
  DiscardDraftsResponse,
  GenerateInvoiceResponse,
} from "@shared/api";
import { POT_DISPLAY_LABELS, type InvoicePotKey } from "@shared/domain/budget-invoice-split";
import {
  isLateSignedFollowUp,
  BILLING_BLOCK_SHORT_LABELS,
  type BillingBlockReason,
} from "@shared/domain/billing-eligibility";
import { MONTH_NAMES } from "../constants";
import { getCustomerName, formatSentAt } from "../utils";

const SPLIT_COUNT_WORDS = ["null", "eine", "zwei", "drei", "vier"];

// Task #1010: Beschriftet den Split-Hinweis exakt nach den betroffenen Töpfen.
// „Privat" erscheint nur, wenn ein echter Selbstzahler-Anteil dabei ist;
// reine Kassen-Aufteilungen heißen „Kassen-Rechnungen".
function buildSplitHint(splitPots: InvoicePotKey[]): string {
  const count = splitPots.length;
  const countWord = SPLIT_COUNT_WORDS[count] ?? String(count);
  const hasPrivateShare = splitPots.includes("private");
  const kind = hasPrivateShare ? "Rechnungen" : "Kassen-Rechnungen";
  const labels = splitPots.map((pot) => POT_DISPLAY_LABELS[pot]).join(" + ");
  return `Wird in ${countWord} ${kind} aufgeteilt (${labels}).`;
}

// Task #1869 — Reihenfolge der Erklär-Gruppen im „Nicht abgerechnet"-Block:
// fehlende Unterschrift zuerst (die eigentliche, behebbare Ursache einer
// Null-Summe), danach die neutral-informativen „bereits abgerechnet"-Termine.
const EXCLUDED_REASON_ORDER: BillingBlockReason[] = [
  "customer_signature_required",
  "not_signed",
  "already_billed",
  "no_appointments",
];

interface NewInvoiceDialogProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  setSelectedCustomerId: (id: string) => void;
  customers: BillingCustomerItem[] | undefined;
  selectedCustomerId: string;
  selectedMonth: number;
  selectedYear: number;
  previewCustomerId: number | null;
  invoicePreview: BillingInvoicePreview | undefined;
  previewLoading: boolean;
  previewError: boolean;
  previewErrorObj: unknown;
  blockingDrafts: BlockingDraftInvoice[] | undefined;
  onDiscardClick: () => void;
  discardDraftsMutation: UseMutationResult<DiscardDraftsResponse, Error, { customerId: number; month: number; year: number }, unknown>;
  generateMutation: UseMutationResult<GenerateInvoiceResponse, Error, { customerId: number; billingMonth: number; billingYear: number; dateFrom?: string; dateTo?: string; confirmPartial?: boolean; partialReason?: string }, unknown>;
  // Task #1883 — Opt-in fürs bewusste Teil-Abrechnen wird beim Erstellen mitgegeben.
  onGenerate: (opts?: { confirmPartial?: boolean; partialReason?: string }) => void;
}

export function NewInvoiceDialog({
  open,
  setOpen,
  setSelectedCustomerId,
  customers,
  selectedCustomerId,
  selectedMonth,
  selectedYear,
  previewCustomerId,
  invoicePreview,
  previewLoading,
  previewError,
  previewErrorObj,
  blockingDrafts,
  onDiscardClick,
  discardDraftsMutation,
  generateMutation,
  onGenerate,
}: NewInvoiceDialogProps) {
  // Task #1883 — Opt-in fürs bewusste Teil-Abrechnen (Variante B). Zurückgesetzt,
  // sobald ein anderer Kunde vorschaut wird, damit die Bestätigung nie versehentlich
  // von einem Kunden auf den nächsten übernommen wird.
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [partialReason, setPartialReason] = useState("");
  useEffect(() => {
    setConfirmPartial(false);
    setPartialReason("");
  }, [previewCustomerId]);

  // Task #1883 — Termine, die STILL aus der Rechnung fielen (mangels Kunden-
  // unterschrift bzw. Leistungsnachweis) — `already_billed` (bekannt/gewollt) zählt
  // NICHT. Dieselbe Ausschluss-SSoT wie der Server-Guard. Sind welche vorhanden,
  // verlangt die Erstellung eine ausdrückliche Teil-Abrechnungs-Bestätigung.
  const silentlyDropped = (invoicePreview?.excludedAppointments ?? []).filter(
    (e) => e.reason !== "already_billed",
  );
  const needsPartialConfirmation = silentlyDropped.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSelectedCustomerId(""); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Neue Rechnung erstellen</DialogTitle>
          <DialogDescription>
            Rechnung für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} generieren
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Kunde</label>
            {customers && customers.length === 0 ? (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3" data-testid="text-no-eligible-customers">
                Keine Kunden mit unterschriebenen Leistungsnachweisen für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} vorhanden.
              </div>
            ) : (
              <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                <SelectTrigger data-testid="select-invoice-customer">
                  <SelectValue placeholder="Kunden auswählen..." />
                </SelectTrigger>
                <SelectContent>
                  {customers?.map((c) => {
                    // Task #576: Partial-Signing-Hinweis im Dropdown.
                    // Wenn weniger Termine durch einen aktiven LN
                    // abgedeckt sind als dokumentiert wurden, sieht
                    // der Admin sofort, dass evtl. ein zweiter LN
                    // fehlt — und versucht nicht erst, eine Rechnung
                    // zu generieren, die nur einen Teil enthält.
                    const partial = c.completedAppointments > 0
                      && c.coveredAppointments < c.completedAppointments;
                    return (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {getCustomerName(c)}
                        {c.status === "inaktiv" ? " (inaktiv)" : ""}
                        {partial
                          ? ` — nur ${c.coveredAppointments}/${c.completedAppointments} Termine im LN`
                          : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Task #750: Vorschau-Block — zeigt exakt die Werte, die die
              nachfolgende Rechnung tragen wird (gemeinsamer Helper im Server). */}
          {previewCustomerId !== null && (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2"
              data-testid="block-invoice-preview"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Vorschau
              </div>
              {previewLoading ? (
                <div className="flex items-center text-sm text-gray-500" data-testid="text-preview-loading">
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                  Wird berechnet...
                </div>
              ) : previewError || !invoicePreview ? (
                <div className="space-y-2">
                  <div className="text-sm text-amber-700" data-testid="text-preview-error">
                    {(() => {
                      // Task #816 — Die konkrete fachliche Server-Meldung (400)
                      // anzeigen statt der generischen „nicht verfügbar". Bei
                      // unerwarteten Fehlern (Netzwerk/5xx, keine spezifische
                      // Meldung) bleibt der allgemeine Fallback erhalten.
                      const apiErr = previewErrorObj as (Error & { status?: number }) | null;
                      const isClientError = !!apiErr?.status && apiErr.status >= 400 && apiErr.status < 500;
                      const serverMessage = isClientError ? apiErr?.message?.trim() : undefined;
                      return serverMessage || "Vorschau nicht verfügbar.";
                    })()}
                  </div>
                  {/* Task #817 — Verwaiste Entwurfs-Rechnungen, die die Termine
                      blockieren, direkt aus dem Dialog auflösen. Nur Entwürfe
                      (nie festgeschrieben) werden angeboten. */}
                  {blockingDrafts && blockingDrafts.length > 0 && (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-2"
                      data-testid="block-blocking-drafts"
                    >
                      <div className="text-xs text-amber-800">
                        {blockingDrafts.length === 1
                          ? "Ein alter Rechnungs-Entwurf blockiert die Termine:"
                          : `${blockingDrafts.length} alte Rechnungs-Entwürfe blockieren die Termine:`}
                        {" "}
                        <span className="font-medium">
                          {blockingDrafts.map((d) => d.invoiceNumber).join(", ")}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-amber-300 text-amber-800 hover:bg-amber-100"
                        onClick={onDiscardClick}
                        disabled={discardDraftsMutation.isPending}
                        data-testid="button-discard-drafts"
                      >
                        {discardDraftsMutation.isPending ? (
                          <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                        ) : (
                          <Ban className={`${iconSize.sm} mr-1`} />
                        )}
                        {blockingDrafts.length === 1 ? "Entwurf verwerfen" : "Entwürfe verwerfen"}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div data-testid="text-preview-service-records">
                    <div className="text-xs text-gray-500">Leistungsnachweise</div>
                    <div className="font-semibold text-gray-900">{invoicePreview.serviceRecordCount}</div>
                  </div>
                  <div data-testid="text-preview-appointments">
                    <div className="text-xs text-gray-500">Termine</div>
                    <div className="font-semibold text-gray-900">
                      {invoicePreview.coveredAppointments}
                      {/* Task #1813 — amber-Hinweis NUR noch für wirklich
                          un-/unterdokumentierte Termine: dokumentiert minus
                          jetzt-abgerechnet minus bereits-abgerechnet. Bereits
                          abgerechnete (Nachberechnung) werden neutral separat
                          ausgewiesen, nicht mehr als Warnung. */}
                      {invoicePreview.completedAppointments
                        - invoicePreview.coveredAppointments
                        - invoicePreview.alreadyBilledAppointments > 0 && (
                        <span className="ml-1 text-xs font-normal text-amber-700">
                          von {invoicePreview.completedAppointments} dokumentiert
                        </span>
                      )}
                    </div>
                    {invoicePreview.alreadyBilledAppointments > 0 && (
                      <div
                        className="mt-0.5 text-xs font-normal text-gray-500"
                        data-testid="text-preview-already-billed"
                      >
                        {invoicePreview.alreadyBilledAppointments} bereits abgerechnet
                      </div>
                    )}
                  </div>
                  <div data-testid="text-preview-total">
                    <div className="text-xs text-gray-500">Summe (brutto)</div>
                    <div className="font-semibold text-gray-900">
                      {formatEuroDE(invoicePreview.totalCents)}
                    </div>
                  </div>
                </div>
              )}
              {/* Task #1813 — Beruhigender Hinweis bei einer Nachberechnung
                  (spät unterschriebene Nachzügler). Gemeinsame SSoT-Regel
                  `isLateSignedFollowUp`, dieselbe wie in der Liste. */}
              {invoicePreview && isLateSignedFollowUp({
                signedAppointmentCount:
                  invoicePreview.coveredAppointments + invoicePreview.alreadyBilledAppointments,
                unbilledAppointmentCount: invoicePreview.coveredAppointments,
              }) && (
                <div className="text-xs text-sky-700" data-testid="text-preview-followup-hint">
                  Nachberechnung: {invoicePreview.coveredAppointments}{" "}
                  {invoicePreview.coveredAppointments === 1 ? "Termin wurde" : "Termine wurden"}{" "}
                  nachträglich unterschrieben und waren nicht Teil der früheren Rechnung. Sie werden
                  nicht doppelt abgerechnet.
                </div>
              )}
              {invoicePreview?.splitInvoices && invoicePreview.splitPots?.length > 0 && (
                <div className="text-xs text-gray-600" data-testid="text-preview-split-hint">
                  {buildSplitHint(invoicePreview.splitPots)}
                </div>
              )}
              {/* Task #1869 — Erklärt eine Null-/Teil-Summe konkret: welche
                  dokumentierten Termine NICHT abgerechnet werden und warum
                  (fehlende Kundenunterschrift vs. bereits abgerechnet) — mit den
                  betroffenen Terminen, damit der Admin weiß, welcher
                  Leistungsnachweis noch unterschrieben werden muss. Wortlaut aus
                  derselben SSoT (`BILLING_BLOCK_SHORT_LABELS`) wie die
                  Kundenzeile der Karte „Noch zu erstellen". */}
              {invoicePreview
                && invoicePreview.excludedAppointments.length > 0
                && (needsPartialConfirmation
                  || invoicePreview.totalCents === 0
                  || invoicePreview.coveredAppointments < invoicePreview.completedAppointments)
                && (() => {
                  const byReason = new Map<BillingBlockReason, string[]>();
                  for (const ex of invoicePreview.excludedAppointments) {
                    const list = byReason.get(ex.reason) ?? [];
                    list.push(ex.date);
                    byReason.set(ex.reason, list);
                  }
                  const groups = EXCLUDED_REASON_ORDER
                    .filter((reason) => byReason.has(reason))
                    .map((reason) => ({
                      reason,
                      dates: (byReason.get(reason) ?? []).slice().sort(),
                    }));
                  return (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-2"
                      data-testid="block-excluded-appointments"
                    >
                      <div className="text-xs font-medium text-amber-800">
                        Nicht abgerechnet — Grund je Termin:
                      </div>
                      {groups.map(({ reason, dates }) => (
                        <div key={reason} className="text-xs text-amber-800" data-testid={`block-excluded-${reason}`}>
                          <span className="font-medium">{BILLING_BLOCK_SHORT_LABELS[reason]}</span>
                          {" — "}
                          <span>{dates.map((d) => formatSentAt(d)).join(", ")}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              {/* Task #1883 — Opt-in fürs bewusste Teil-Abrechnen (Variante B).
                  Erscheint NUR, wenn dokumentierte Termine sonst still fielen. Ohne
                  Häkchen bleibt „Rechnung erstellen" gesperrt (der Server-Guard würde
                  ohnehin mit 409 ablehnen) — nichts wird still teil-abgerechnet. */}
              {needsPartialConfirmation && (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 p-2 space-y-2"
                  data-testid="block-confirm-partial"
                >
                  <label className="flex items-start gap-2 text-xs text-amber-900">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={confirmPartial}
                      onChange={(e) => setConfirmPartial(e.target.checked)}
                      data-testid="checkbox-confirm-partial"
                    />
                    <span>
                      Teil-Abrechnung bestätigen: den signierten Teil jetzt abrechnen; die{" "}
                      {silentlyDropped.length}{" "}
                      {silentlyDropped.length === 1 ? "genannten Termin" : "genannten Termine"}{" "}
                      später mit Kundenunterschrift / Leistungsnachweis nachreichen.
                    </span>
                  </label>
                  {confirmPartial && (
                    <input
                      type="text"
                      value={partialReason}
                      maxLength={500}
                      onChange={(e) => setPartialReason(e.target.value)}
                      placeholder="Grund (optional)"
                      className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs text-gray-800"
                      data-testid="input-partial-reason"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-gray-700">Monat</label>
              <div className="text-sm text-gray-900 p-2 bg-gray-50 rounded-md">
                {MONTH_NAMES[selectedMonth - 1]}
              </div>
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-gray-700">Jahr</label>
              <div className="text-sm text-gray-900 p-2 bg-gray-50 rounded-md">
                {selectedYear}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button
            onClick={() =>
              onGenerate({
                confirmPartial: needsPartialConfirmation ? confirmPartial : undefined,
                partialReason: needsPartialConfirmation && partialReason.trim() ? partialReason.trim() : undefined,
              })
            }
            disabled={
              generateMutation.isPending
              || !selectedCustomerId
              // Task #1881 — Kein leerer Lauf: Wenn die Vorschau nichts
              // Abrechenbares enthält (0 abgedeckte Termine ⇒ Summe 0 €), bleibt
              // der Grund im Erklär-Block sichtbar, aber „Rechnung erstellen"
              // ist deaktiviert (der Generate-Pfad würde ohnehin ablehnen).
              || (!!invoicePreview && invoicePreview.coveredAppointments === 0)
              // Task #1883 — Mischkunde: solange die Teil-Abrechnung nicht bestätigt
              // ist, bleibt „Erstellen" gesperrt (nichts still teil-abrechnen).
              || (needsPartialConfirmation && !confirmPartial)
            }
            className="bg-teal-600 hover:bg-teal-700 text-white"
            data-testid="button-generate-invoice"
          >
            {generateMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird erstellt...
              </>
            ) : (
              <>
                <FileText className={`${iconSize.sm} mr-1`} />
                Rechnung erstellen
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
