import { useMemo, useState, useEffect} from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { iconSize } from "@/design-system";
import { Loader2, Link2, Unlink, Upload, Zap, RefreshCw, History, Ban, RotateCcw, Plus, Trash2, EyeOff, Sparkles, Check, X, Layers, ChevronDown, ChevronUp, AlertTriangle, CheckCheck } from "lucide-react";
import { formatCents, formatDate, confidenceBadge } from "../utils";
import {
  useQontoTransactions,
  useMatchableInvoices,
  useTransactionMutations,
  useSyncMutation,
  useBackfillMutation,
  useQontoBackfillStatus,
  useQontoHideRules,
  useHideRuleMutations,
  useAdviceSuggestions,
  useMatchedInvoicesForTransaction,
} from "../hooks";
import { Checkbox } from "@/components/ui/checkbox";
import type { MatchFilter, AdviceSuggestionCandidate } from "../types";
import { BULK_ADVICE_TOLERANCE_CENTS } from "@shared/domain/qonto/bulk-advice-match";
import {
  enumerateMonthlyWindows,
  exceedsBackfillLookbackCap,
  MAX_BACKFILL_LOOKBACK_MONTHS,
} from "@shared/domain/qonto/backfill-windows";

// Task #1599 — Vorbelegtes Standard-Startdatum für den Voll-Abruf.
const DEFAULT_BACKFILL_START = "2026-06-01";

// Task #1606 — Schwelle, ab der ein Backfill als „groß/langsam" gilt.
const LARGE_BACKFILL_WINDOW_THRESHOLD = 6;

/**
 * Task #1606 — Schätzt Umfang eines Backfills ab dem gewählten Startdatum bis
 * heute: Anzahl der Monats-Fenster (== Qonto-Abfragen pro Konto) und wie weit
 * zurück der Zeitraum reicht. Reine Anzeige-Hilfe, ändert die Backfill-Semantik
 * nicht.
 */
function estimateBackfillScope(startDateStr: string): {
  windowCount: number;
  monthsBack: number;
  isLarge: boolean;
  exceedsCap: boolean;
} | null {
  if (!startDateStr) return null;
  const start = new Date(`${startDateStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  if (start.getTime() > now.getTime()) {
    return { windowCount: 0, monthsBack: 0, isLarge: false, exceedsCap: false };
  }
  const windowCount = enumerateMonthlyWindows(start, now).length;
  const monthsBack =
    (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  return {
    windowCount,
    monthsBack,
    isLarge: windowCount >= LARGE_BACKFILL_WINDOW_THRESHOLD,
    // Task #1607 — reicht der Zeitraum über die harte Rückreichweiten-Grenze
    // hinaus, ist eine explizite Zusatz-Bestätigung nötig.
    exceedsCap: exceedsBackfillLookbackCap(start, now),
  };
}

function formatMonthsBack(monthsBack: number): string {
  if (monthsBack <= 0) return "den aktuellen Monat";
  const years = Math.floor(monthsBack / 12);
  const months = monthsBack % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(years === 1 ? "1 Jahr" : `${years} Jahre`);
  if (months > 0) parts.push(months === 1 ? "1 Monat" : `${months} Monate`);
  return parts.length > 0 ? parts.join(" und ") : "unter 1 Monat";
}

export function TransactionsTab({
  configured,
  matchFilter,
  onFilterChange,
  lastSync,
  highlightInvoiceId,
}: {
  configured: boolean;
  matchFilter: MatchFilter;
  onFilterChange: (v: MatchFilter) => void;
  lastSync?: string | null;
  /**
   * #1897 — Absprung aus der Rechnungsliste (`/admin/qonto?invoiceId=…`).
   * Die zugeordnete Zahlung wird hervorgehoben und in den Blick gescrollt.
   * Aufgeloest wird ueber `matchedInvoiceId`, also den 1:1-Match; bei einer
   * Bindung ueber ein Sammel-Avis traegt keine Transaktion die Rechnungs-ID
   * und es bleibt bei der Navigation ohne Hervorhebung (siehe FINDING).
   */
  highlightInvoiceId?: number | null;
}) {
  const [matchingTxId, setMatchingTxId] = useState<number | null>(null);
  // Task #1742 — welche zugeordnete Zahlung ist gerade aufgeklappt (Details zu
  // den zugrunde liegenden Rechnungen). Immer nur eine gleichzeitig.
  const [detailTxId, setDetailTxId] = useState<number | null>(null);
  const [backfillConfirmOpen, setBackfillConfirmOpen] = useState(false);
  const [backfillDate, setBackfillDate] = useState(DEFAULT_BACKFILL_START);
  const [extendedLookbackAck, setExtendedLookbackAck] = useState(false);
  const backfillScope = useMemo(() => estimateBackfillScope(backfillDate), [backfillDate]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [newRuleType, setNewRuleType] = useState<"counterparty" | "iban">("counterparty");
  const [newRuleValue, setNewRuleValue] = useState("");
  // Nur zugeordnete Zahlungen anzeigen, deren gezahlter Betrag über die Toleranz
  // hinaus von der Rechnungsforderung abweicht (Kürzung/Überzahlung, zur Prüfung).
  const [showOnlyDifferences, setShowOnlyDifferences] = useState(false);

  const transactionsQuery = useQontoTransactions(matchFilter, configured);

  // #1897 — die hervorzuhebende Zahlung, sobald die Liste geladen ist.
  const highlightedTxId = useMemo(() => {
    if (highlightInvoiceId == null) return null;
    const hit = (transactionsQuery.data?.transactions ?? [])
      .find(t => t.matchedInvoiceId === highlightInvoiceId);
    return hit?.id ?? null;
  }, [highlightInvoiceId, transactionsQuery.data]);

  // Einmal in den Blick scrollen, sobald die Karte im DOM ist.
  useEffect(() => {
    if (highlightedTxId == null) return;
    const el = document.querySelector(`[data-testid="transaction-card-${highlightedTxId}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [highlightedTxId]);
  const invoicesQuery = useMatchableInvoices(matchingTxId !== null);
  // Task #1742 — lazy: erst laden, wenn eine zugeordnete Zahlung aufgeklappt ist.
  const matchedInvoicesQuery = useMatchedInvoicesForTransaction(detailTxId, detailTxId !== null);
  const hideRulesQuery = useQontoHideRules(configured && rulesOpen);
  const { createRuleMutation, deleteRuleMutation } = useHideRuleMutations();

  const syncMutation = useSyncMutation();
  const backfillMutation = useBackfillMutation();
  const backfillStatusQuery = useQontoBackfillStatus(configured);
  const backfillRunning = backfillStatusQuery.data?.running ?? false;
  const backfillBusy = backfillMutation.isPending || backfillRunning;

  const handleCreateRule = () => {
    const value = newRuleValue.trim();
    if (!value) return;
    createRuleMutation.mutate(
      { ruleType: newRuleType, value },
      { onSuccess: () => setNewRuleValue("") },
    );
  };

  // Task #1710 — Auswahl für die manuelle (Mehrfach-)Zuordnung. 1 Rechnung ⇒
  // 1:1-Match, 2+ ⇒ Sammel-Bulk-Match. Wird beim Schließen des Panels geleert.
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<number[]>([]);

  // Task #1711 — Bestätigungsdialog, wenn die Summe der gewählten Rechnungen
  // vom Zahlbetrag abweicht.
  const [mismatchConfirm, setMismatchConfirm] = useState<{
    txId: number;
    selectedSum: number;
    txAmount: number;
    count: number;
  } | null>(null);

  const {
    matchMutation,
    bulkMatchMutation,
    unmatchMutation,
    autoMatchMutation,
    csvImportMutation,
    ignoreMutation,
    unignoreMutation,
    confirmAdviceMutation,
    dismissAdviceSuggestionMutation,
    confirmPaidMutation,
  } = useTransactionMutations({
    onMatchSuccess: () => {
      setMatchingTxId(null);
      setSelectedInvoiceIds([]);
    },
  });

  const toggleInvoiceSelection = (invoiceId: number) => {
    setSelectedInvoiceIds(prev =>
      prev.includes(invoiceId) ? prev.filter(id => id !== invoiceId) : [...prev, invoiceId],
    );
  };

  const openMatchPanel = (txId: number) => {
    const next = matchingTxId === txId ? null : txId;
    setMatchingTxId(next);
    setSelectedInvoiceIds([]);
  };

  const runMatch = (txId: number) => {
    if (selectedInvoiceIds.length === 1) {
      matchMutation.mutate({ txId, invoiceId: selectedInvoiceIds[0] });
    } else if (selectedInvoiceIds.length >= 2) {
      bulkMatchMutation.mutate({ txId, invoiceIds: selectedInvoiceIds });
    }
  };

  const submitMatch = (txId: number) => {
    const tx = (transactionsQuery.data?.transactions ?? []).find(t => t.id === txId);
    if (!tx) return;
    const selectedSum = (invoicesQuery.data ?? [])
      .filter(inv => selectedInvoiceIds.includes(inv.id))
      .reduce((acc, inv) => acc + inv.grossAmountCents, 0);
    const txAmount = Math.abs(tx.amountCents);
    // Task #1711 — Weicht die Summe der gewählten Rechnungen vom Zahlbetrag ab,
    // ist eine explizite Bestätigung Pflicht (Fehl-Zuordnungen sind mühsam zu
    // korrigieren). Exakte Treffer werden direkt mit einem Klick zugeordnet.
    if (selectedSum !== txAmount) {
      setMismatchConfirm({ txId, selectedSum, txAmount, count: selectedInvoiceIds.length });
      return;
    }
    runMatch(txId);
  };

  // Task #1672 — rückwirkende Sammel-Avis-Vorschläge (nur relevant, solange
  // offene/alle Transaktionen sichtbar sind). Map txId → Kandidaten.
  const suggestionsQuery = useAdviceSuggestions(configured && matchFilter !== "ignored" && matchFilter !== "matched");
  const suggestionsByTx = useMemo(() => {
    const m = new Map<number, AdviceSuggestionCandidate[]>();
    for (const s of suggestionsQuery.data?.suggestions ?? []) m.set(s.transactionId, s.candidates);
    return m;
  }, [suggestionsQuery.data]);

  const [csvImporting, setCsvImporting] = useState(false);

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvImporting(true);
    try {
      const csvContent = await file.text();
      await csvImportMutation.mutateAsync(csvContent);
    } finally {
      setCsvImporting(false);
      e.target.value = "";
    }
  };

  if (!configured) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-gray-500">
          Bitte zuerst die Qonto-Zugangsdaten unter Einstellungen → Qonto-Verbindung hinterlegen (Login, Secret Key und IBAN).
        </CardContent>
      </Card>
    );
  }

  // Task #1735 — streng nach Emissionsdatum absteigend (neueste oben). Der Server
  // liefert bereits desc(emittedAt); wir sortieren defensiv erneut mit stabilem
  // Index-Tiebreak bei gleichem Datum. Kein Hook (steht nach Early-Return).
  const transactions = (transactionsQuery.data?.transactions ?? [])
    .filter(tx =>
      !showOnlyDifferences ||
      tx.paymentDifferenceResult === "underpaid" ||
      tx.paymentDifferenceResult === "overpaid" ||
      // Task #1864 — reine Betrags-Treffer im Prüf-Zustand gehören ebenfalls in die
      // „zu prüfen"-Ansicht (gebunden, aber NICHT bezahlt).
      tx.matchConfidence === "auto_amount_review")
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => {
      const r = new Date(b.tx.emittedAt).getTime() - new Date(a.tx.emittedAt).getTime();
      return r !== 0 ? r : a.i - b.i;
    })
    .map((x) => x.tx);

  return (
    <div className="space-y-4">
      {/* Sync-Leiste: Transaktionen von Qonto abrufen */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-gray-500" data-testid="text-last-sync">
            {lastSync
              ? `Letzter Sync: ${formatDate(lastSync)} um ${new Date(lastSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
              : "Noch nicht synchronisiert"}
          </p>
          {backfillRunning && (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700"
              data-testid="text-backfill-running"
            >
              <Loader2 className={`${iconSize.sm} animate-spin`} />
              Voll-Sync läuft… bitte warten
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || backfillBusy}
            className="w-full sm:w-auto"
            data-testid="button-sync"
          >
            {syncMutation.isPending ? (
              <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
            ) : (
              <RefreshCw className={`${iconSize.sm} mr-2`} />
            )}
            Jetzt synchronisieren
          </Button>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={backfillDate}
              onChange={e => setBackfillDate(e.target.value)}
              disabled={syncMutation.isPending || backfillBusy}
              className="w-[150px]"
              aria-label="Startdatum für den Abruf"
              data-testid="input-backfill-date"
            />
            <Button
              variant="outline"
              onClick={() => setBackfillConfirmOpen(true)}
              disabled={syncMutation.isPending || backfillBusy || !backfillDate}
              className="w-full sm:w-auto"
              data-testid="button-backfill"
              title={
                backfillRunning
                  ? "Ein Voll-Sync läuft bereits (ggf. in einer anderen Sitzung). Bitte warten Sie, bis er abgeschlossen ist."
                  : "Ruft alle Transaktionen ab dem gewählten Datum über ALLE Konten (Haupt- + Zusatzkonten) ab."
              }
            >
              {backfillBusy ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <History className={`${iconSize.sm} mr-2`} />
              )}
              {backfillRunning ? "Voll-Sync läuft…" : "Ab Datum abrufen"}
            </Button>
          </div>
        </div>
      </div>

      {/* Abgleich-Leiste: Filter + Zuordnungs-Aktionen */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={matchFilter} onValueChange={v => onFilterChange(v as MatchFilter)}>
            <SelectTrigger className="w-[240px]" data-testid="select-match-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Transaktionen</SelectItem>
              <SelectItem value="unmatched">Offen (ohne Zuordnung)</SelectItem>
              <SelectItem value="matched">Zugeordnet</SelectItem>
              <SelectItem value="ignored">Nicht abrechnungsrelevant</SelectItem>
            </SelectContent>
          </Select>
          {/* Client-seitiger Zusatzfilter: nur zugeordnete Zahlungen mit
              Betragsdifferenz (zur Prüfung). Wirkt auf die bereits geladene Liste. */}
          <Button
            variant={showOnlyDifferences ? "default" : "outline"}
            onClick={() => setShowOnlyDifferences(v => !v)}
            aria-pressed={showOnlyDifferences}
            title="Nur zugeordnete Zahlungen mit Betragsdifferenz oder prüfbedürftigem Betrags-Treffer anzeigen"
            data-testid="button-filter-differences"
          >
            <AlertTriangle className={`${iconSize.sm} mr-2`} />
            Nur Differenzen
          </Button>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setRulesOpen(o => !o)}
            data-testid="button-toggle-hide-rules"
          >
            <EyeOff className={`${iconSize.sm} mr-2`} />
            Auto-Ausblenden
          </Button>
          <Button
            variant="outline"
            onClick={() => autoMatchMutation.mutate()}
            disabled={autoMatchMutation.isPending}
            data-testid="button-auto-match"
          >
            {autoMatchMutation.isPending ? (
              <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
            ) : (
              <Zap className={`${iconSize.sm} mr-2`} />
            )}
            Auto-Abgleich
          </Button>
          <Button
            variant="outline"
            onClick={() => document.getElementById("csv-import-input")?.click()}
            disabled={csvImporting}
            data-testid="button-csv-import"
          >
            {csvImporting ? (
              <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
            ) : (
              <Upload className={`${iconSize.sm} mr-2`} />
            )}
            CSV importieren
          </Button>
          <input
            id="csv-import-input"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCsvImport}
            data-testid="input-csv-import"
          />
        </div>
      </div>

      {rulesOpen && (
        <Card data-testid="card-hide-rules">
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-sm font-medium">Automatisch ausblenden</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Eingehende Transaktionen, deren Gegenpartei den Text enthält oder deren
                Quell-IBAN übereinstimmt, werden beim Abrufen automatisch als „nicht
                abrechnungsrelevant" markiert. Manuell wieder eingeblendete Transaktionen
                bleiben dauerhaft sichtbar.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Typ</Label>
                <Select value={newRuleType} onValueChange={v => setNewRuleType(v as "counterparty" | "iban")}>
                  <SelectTrigger className="w-[180px]" data-testid="select-rule-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="counterparty">Gegenpartei enthält</SelectItem>
                    <SelectItem value="iban">Quell-IBAN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <Label className="text-xs">Wert</Label>
                <Input
                  value={newRuleValue}
                  onChange={e => setNewRuleValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateRule();
                    }
                  }}
                  placeholder={newRuleType === "iban" ? "DE.. IBAN" : "z.B. Finanzamt"}
                  data-testid="input-rule-value"
                />
              </div>
              <Button
                onClick={handleCreateRule}
                disabled={createRuleMutation.isPending || !newRuleValue.trim()}
                data-testid="button-add-rule"
              >
                {createRuleMutation.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Plus className={`${iconSize.sm} mr-2`} />
                )}
                Regel hinzufügen
              </Button>
            </div>

            {hideRulesQuery.isLoading ? (
              <Loader2 className={`${iconSize.sm} animate-spin`} />
            ) : (hideRulesQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-gray-500" data-testid="text-no-rules">
                Noch keine Regeln angelegt.
              </p>
            ) : (
              <div className="space-y-1">
                {(hideRulesQuery.data ?? []).map(rule => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-2 rounded border px-3 py-1.5"
                    data-testid={`rule-row-${rule.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-xs shrink-0">
                        {rule.ruleType === "iban" ? "Quell-IBAN" : "Gegenpartei"}
                      </Badge>
                      <span className="text-sm font-mono truncate">{rule.value}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteRuleMutation.mutate(rule.id)}
                      disabled={deleteRuleMutation.isPending}
                      aria-label="Regel löschen"
                      data-testid={`button-delete-rule-${rule.id}`}
                    >
                      <Trash2 className={iconSize.sm} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {transactionsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : transactions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500">
            Keine Transaktionen gefunden. Bitte zuerst synchronisieren.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {transactions.map(tx => (
            <Card
              key={tx.id}
              // #1897 — Hervorhebung des Absprung-Ziels. Bewusst ein neutraler
              // Ring statt einer Ampel-Farbe: es ist ein Wegweiser, keine
              // Bewertung der Zahlung.
              className={highlightedTxId === tx.id ? "ring-2 ring-teal-400" : undefined}
              data-testid={`transaction-card-${tx.id}`}
              data-highlighted={highlightedTxId === tx.id ? "true" : undefined}
            >
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{formatCents(tx.amountCents)}</span>
                      <span className="text-xs text-gray-500">{formatDate(tx.emittedAt)}</span>
                      {tx.billingIrrelevantAt ? (
                        <Badge variant="outline" className="bg-gray-100 text-gray-600 border-gray-300 text-xs" data-testid={`badge-irrelevant-${tx.id}`}>
                          Nicht abrechnungsrelevant
                        </Badge>
                      ) : tx.matchedPaymentAdviceId ? (
                        <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-200 text-xs" data-testid={`badge-advice-matched-${tx.id}`}>
                          <Layers className={`${iconSize.xs} mr-1`} />
                          Sammel-Avis zugeordnet
                        </Badge>
                      ) : tx.matchedInvoiceId ? (
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs" data-testid={`badge-matched-${tx.id}`}>
                          Zugeordnet
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs" data-testid={`badge-unmatched-${tx.id}`}>
                          Offen
                        </Badge>
                      )}
                      {(tx.matchedInvoiceId || tx.matchedPaymentAdviceId) && tx.matchConfidence && (() => {
                        const badge = confidenceBadge(tx.matchConfidence);
                        return (
                          <Badge variant="outline" className={`${badge.className} text-xs`} data-testid={`badge-confidence-${tx.id}`}>
                            {badge.label}
                          </Badge>
                        );
                      })()}
                      {/* Task #1822: Teilzahlung — die Summe der eingegangenen Zahlungen
                          deckt die Forderung noch nicht vollständig. Statt eines nackten
                          „Unterzahlung"-Fehlers wird der bereits gezahlte Betrag und der
                          offene Rest gezeigt (kumuliert über alle gebundenen Zahlungen).
                          Die Rechnung steht auf „teilweise bezahlt", nicht auf „bezahlt". */}
                      {tx.paymentDifferenceResult === "underpaid" && tx.paymentDifferenceCents != null && tx.matchedGrossCents != null && (
                        <Badge variant="outline" className="bg-cyan-50 text-cyan-700 border-cyan-200 text-xs" data-testid={`badge-partial-${tx.id}`}>
                          Teilzahlung: {formatCents(tx.matchedGrossCents - tx.paymentDifferenceCents)} von {formatCents(tx.matchedGrossCents)} — Rest {formatCents(tx.paymentDifferenceCents)} offen
                        </Badge>
                      )}
                      {tx.paymentDifferenceResult === "overpaid" && tx.paymentDifferenceCents != null && (
                        <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 text-xs" data-testid={`badge-overpaid-${tx.id}`}>
                          +{formatCents(Math.abs(tx.paymentDifferenceCents))} Überzahlung
                        </Badge>
                      )}
                      {tx.sourceIban && (
                        <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200 text-xs font-mono" data-testid={`badge-source-iban-${tx.id}`}>
                          Konto …{tx.sourceIban.slice(-4)}
                        </Badge>
                      )}
                    </div>
                    {tx.counterpartyName && (
                      <p className="text-sm text-gray-700 mt-1 truncate">{tx.counterpartyName}</p>
                    )}
                    {tx.reference && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">Ref: {tx.reference}</p>
                    )}
                    {tx.label && tx.label !== tx.reference && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{tx.label}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {tx.billingIrrelevantAt ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => unignoreMutation.mutate(tx.id)}
                        disabled={unignoreMutation.isPending}
                        aria-label="Markierung aufheben"
                        title={'Markierung „nicht abrechnungsrelevant" aufheben'}
                        data-testid={`button-unignore-${tx.id}`}
                      >
                        <RotateCcw className={iconSize.sm} />
                      </Button>
                    ) : tx.matchedInvoiceId || tx.matchedPaymentAdviceId ? (
                      <>
                        {/* Differenz bewusst akzeptieren: eine gebundene, aber wegen
                            Betragsabweichung noch offene Rechnung final auf „bezahlt"
                            setzen (serverseitig geprüft & auditiert). */}
                        {(tx.paymentDifferenceResult === "underpaid" || tx.paymentDifferenceResult === "overpaid" || tx.matchConfidence === "auto_amount_review") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => confirmPaidMutation.mutate(tx.id)}
                            disabled={confirmPaidMutation.isPending}
                            aria-label={tx.matchConfidence === "auto_amount_review" ? "Betrags-Treffer als bezahlt bestätigen" : "Trotz Differenz als bezahlt bestätigen"}
                            title={tx.matchConfidence === "auto_amount_review" ? "Nur betragsgleicher Treffer — nach Prüfung als bezahlt bestätigen" : "Trotz Differenz als bezahlt bestätigen"}
                            className="text-green-700 hover:text-green-800"
                            data-testid={`button-confirm-paid-${tx.id}`}
                          >
                            <CheckCheck className={iconSize.sm} />
                          </Button>
                        )}
                        {/* Task #1742 — zugeordnete Rechnungen ein-/ausklappen. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDetailTxId(prev => (prev === tx.id ? null : tx.id))}
                          aria-label={detailTxId === tx.id ? "Zugeordnete Rechnungen ausblenden" : "Zugeordnete Rechnungen anzeigen"}
                          aria-expanded={detailTxId === tx.id}
                          title="Zugeordnete Rechnungen anzeigen"
                          data-testid={`button-toggle-matched-invoices-${tx.id}`}
                        >
                          {detailTxId === tx.id ? (
                            <ChevronUp className={iconSize.sm} />
                          ) : (
                            <ChevronDown className={iconSize.sm} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (detailTxId === tx.id) setDetailTxId(null);
                            unmatchMutation.mutate(tx.id);
                          }}
                          disabled={unmatchMutation.isPending}
                          aria-label="Zuordnung aufheben"
                          title={tx.matchedPaymentAdviceId ? "Sammel-Avis-Zuordnung aufheben (Rechnungen wieder öffnen)" : "Zuordnung aufheben"}
                          data-testid={`button-unmatch-${tx.id}`}
                        >
                          <Unlink className={iconSize.sm} />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openMatchPanel(tx.id)}
                          aria-label="Rechnung zuordnen"
                          data-testid={`button-match-${tx.id}`}
                        >
                          <Link2 className={iconSize.sm} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => ignoreMutation.mutate(tx.id)}
                          disabled={ignoreMutation.isPending}
                          aria-label="Als nicht abrechnungsrelevant markieren"
                          title="Als nicht abrechnungsrelevant markieren (aus offenem Abgleich ausblenden)"
                          data-testid={`button-ignore-${tx.id}`}
                        >
                          <Ban className={iconSize.sm} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Task #1672 — rückwirkende Sammel-Avis-Vorschläge für offene Zahlungen */}
                {!tx.billingIrrelevantAt && !tx.matchedInvoiceId && !tx.matchedPaymentAdviceId &&
                  (suggestionsByTx.get(tx.id) ?? []).length > 0 && (
                  <div className="mt-3 pt-3 border-t space-y-2" data-testid={`advice-suggestions-${tx.id}`}>
                    <div className="flex items-center gap-1.5">
                      <Sparkles className={`${iconSize.sm} text-teal-600`} />
                      <Label className="text-xs font-medium text-gray-700">Sammel-Avis-Vorschlag</Label>
                    </div>
                    {(suggestionsByTx.get(tx.id) ?? []).map(cand => (
                      <div
                        key={cand.adviceId}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border border-teal-100 bg-teal-50/50 px-3 py-2"
                        data-testid={`advice-candidate-${tx.id}-${cand.adviceId}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">
                              Avis {cand.avisNummer ?? `#${cand.adviceId}`}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-xs ${cand.strong ? "bg-teal-50 text-teal-700 border-teal-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}
                              data-testid={`advice-candidate-confidence-${tx.id}-${cand.adviceId}`}
                            >
                              {cand.strong ? "empfohlen" : "prüfen"}
                            </Badge>
                          </div>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {cand.invoiceCount} Rechnung{cand.invoiceCount === 1 ? "" : "en"}
                            {cand.gesamtBetragCents != null && ` · ${formatCents(cand.gesamtBetragCents)}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 border-teal-300 text-teal-700 hover:bg-teal-100"
                            onClick={() => confirmAdviceMutation.mutate({ txId: tx.id, adviceId: cand.adviceId })}
                            disabled={confirmAdviceMutation.isPending}
                            data-testid={`button-confirm-advice-${tx.id}-${cand.adviceId}`}
                          >
                            <Check className={`${iconSize.sm} mr-1`} />
                            Zuordnen
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-gray-500"
                      onClick={() => dismissAdviceSuggestionMutation.mutate(tx.id)}
                      disabled={dismissAdviceSuggestionMutation.isPending}
                      data-testid={`button-dismiss-advice-${tx.id}`}
                    >
                      <X className={`${iconSize.xs} mr-1`} />
                      Vorschlag ablehnen
                    </Button>
                  </div>
                )}

                {/* Task #1742 — welche Rechnungen stecken in dieser Zahlung? */}
                {detailTxId === tx.id && (
                  <div className="mt-3 pt-3 border-t space-y-2" data-testid={`matched-invoices-panel-${tx.id}`}>
                    <Label className="text-xs font-medium text-gray-600">
                      Zugeordnete Rechnung(en)
                    </Label>
                    {matchedInvoicesQuery.isLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin`} data-testid={`loading-matched-invoices-${tx.id}`} />
                    ) : matchedInvoicesQuery.isError ? (
                      <p className="text-xs text-red-600" data-testid={`error-matched-invoices-${tx.id}`}>
                        Zugeordnete Rechnungen konnten nicht geladen werden.
                      </p>
                    ) : (matchedInvoicesQuery.data?.invoices ?? []).length === 0 ? (
                      <p className="text-xs text-gray-500" data-testid={`text-no-matched-invoices-${tx.id}`}>
                        Keine Rechnungsdetails verfügbar.
                      </p>
                    ) : (() => {
                      const detail = matchedInvoicesQuery.data!;
                      const diff = detail.sumCents - detail.transactionAmountCents;
                      const reconciled = Math.abs(diff) <= BULK_ADVICE_TOLERANCE_CENTS;
                      return (
                        <>
                          <div className="space-y-1 rounded-md border p-1" data-testid={`matched-invoices-list-${tx.id}`}>
                            {detail.invoices.map(inv => (
                              <div
                                key={inv.id}
                                className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm"
                                data-testid={`matched-invoice-${tx.id}-${inv.id}`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium" data-testid={`matched-invoice-number-${inv.id}`}>
                                      {inv.invoiceNumber}
                                    </span>
                                    <Badge variant="outline" className="text-xs" data-testid={`matched-invoice-status-${inv.id}`}>
                                      {inv.status}
                                    </Badge>
                                    <span className="text-xs text-gray-500" data-testid={`matched-invoice-date-${inv.id}`}>
                                      {formatDate(inv.createdAt)}
                                    </span>
                                  </div>
                                  <p className="text-xs text-gray-600 truncate" data-testid={`matched-invoice-recipient-${inv.id}`}>
                                    {inv.customerName ?? inv.recipientName}
                                  </p>
                                </div>
                                <span className="shrink-0 font-medium" data-testid={`matched-invoice-amount-${inv.id}`}>
                                  {formatCents(inv.grossAmountCents)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <div
                            className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs ${
                              reconciled
                                ? "bg-green-50 text-green-700"
                                : "bg-amber-50 text-amber-700"
                            }`}
                            data-testid={`matched-invoices-reconciliation-${tx.id}`}
                          >
                            <span>
                              Σ {formatCents(detail.sumCents)} / Zahlung {formatCents(detail.transactionAmountCents)}
                            </span>
                            <span data-testid={`matched-invoices-reconciliation-status-${tx.id}`}>
                              {reconciled
                                ? "Stimmt überein"
                                : `Differenz ${formatCents(Math.abs(diff))}`}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                {matchingTxId === tx.id && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <Label className="text-xs font-medium text-gray-600">
                      Rechnung(en) zuordnen — mehrere für eine Sammelzahlung wählbar
                    </Label>
                    {invoicesQuery.isLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin`} />
                    ) : (invoicesQuery.data ?? []).length === 0 ? (
                      <p className="text-xs text-gray-500" data-testid={`text-no-open-invoices-${tx.id}`}>
                        Keine offenen Rechnungen verfügbar.
                      </p>
                    ) : (
                      <>
                        <div className="max-h-56 overflow-y-auto space-y-1 rounded-md border p-1" data-testid={`invoice-picker-${tx.id}`}>
                          {(invoicesQuery.data ?? []).map(inv => (
                            <label
                              key={inv.id}
                              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                              data-testid={`invoice-option-${tx.id}-${inv.id}`}
                            >
                              <Checkbox
                                checked={selectedInvoiceIds.includes(inv.id)}
                                onCheckedChange={() => toggleInvoiceSelection(inv.id)}
                                data-testid={`checkbox-invoice-${tx.id}-${inv.id}`}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {inv.invoiceNumber} — {inv.customerName} — {formatCents(inv.grossAmountCents)}
                              </span>
                            </label>
                          ))}
                        </div>
                        {selectedInvoiceIds.length > 0 && (() => {
                          const selectedSum = (invoicesQuery.data ?? [])
                            .filter(inv => selectedInvoiceIds.includes(inv.id))
                            .reduce((acc, inv) => acc + inv.grossAmountCents, 0);
                          const txAmount = Math.abs(tx.amountCents);
                          const mismatch = selectedSum !== txAmount;
                          return (
                            <div className="flex items-center justify-between gap-2 text-xs" data-testid={`match-total-${tx.id}`}>
                              <span className="text-gray-600">
                                {selectedInvoiceIds.length} gewählt · Σ {formatCents(selectedSum)} / Zahlung {formatCents(txAmount)}
                              </span>
                              {mismatch && (
                                <span className="text-amber-600" data-testid={`match-mismatch-${tx.id}`}>
                                  Summe weicht ab
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={selectedInvoiceIds.length === 0 || matchMutation.isPending || bulkMatchMutation.isPending}
                          onClick={() => submitMatch(tx.id)}
                          data-testid={`button-confirm-match-${tx.id}`}
                        >
                          {(matchMutation.isPending || bulkMatchMutation.isPending) && (
                            <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
                          )}
                          {selectedInvoiceIds.length >= 2
                            ? `${selectedInvoiceIds.length} Rechnungen zuordnen`
                            : "Rechnung zuordnen"}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-gray-500 text-center pt-2">
            {transactionsQuery.data?.total ?? 0} Transaktionen gesamt
          </p>
        </div>
      )}

      <AlertDialog
        open={backfillConfirmOpen}
        onOpenChange={open => {
          setBackfillConfirmOpen(open);
          if (!open) setExtendedLookbackAck(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transaktionen ab Datum abrufen?</AlertDialogTitle>
            <AlertDialogDescription>
              Es werden ALLE Transaktionen ab dem {formatDate(backfillDate)} über
              alle Konten (Haupt- und Zusatzkonten) geladen (mehrere Qonto-API-Seiten,
              ggf. viele Transaktionen). Der Vorgang kann etwas dauern und ist keine
              reguläre Sync-Aktion. Für den Regelbetrieb bitte „Jetzt synchronisieren"
              verwenden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {backfillScope && backfillScope.windowCount > 0 && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                backfillScope.isLarge
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-gray-200 bg-gray-50 text-gray-700"
              }`}
              data-testid="text-backfill-scope"
            >
              <p>
                Umfang: <strong>{backfillScope.windowCount}</strong> Monats-Fenster pro Konto
                (Zeitraum: {formatMonthsBack(backfillScope.monthsBack)} zurück).
              </p>
              {backfillScope.isLarge && (
                <p className="mt-1 font-medium" data-testid="text-backfill-large-warning">
                  Das ist ein großer Abruf und kann mehrere Minuten dauern. Für ein
                  aktuelles Startdatum wird der Vorgang deutlich kürzer.
                </p>
              )}
            </div>
          )}
          {/* Task #1607 — Reicht der Zeitraum über die harte Rückreichweiten-
              Grenze hinaus, ist eine explizite Zusatz-Bestätigung Pflicht. */}
          {backfillScope?.exceedsCap && (
            <label
              className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
              data-testid="label-backfill-extended-ack"
            >
              <Checkbox
                checked={extendedLookbackAck}
                onCheckedChange={v => setExtendedLookbackAck(v === true)}
                className="mt-0.5"
                data-testid="checkbox-backfill-extended-ack"
              />
              <span>
                Der Zeitraum reicht weiter als {MAX_BACKFILL_LOOKBACK_MONTHS} Monate zurück.
                Ich bestätige ausdrücklich, dass ich diesen sehr großen, langsamen
                Abzug wirklich starten möchte.
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-backfill">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              disabled={backfillScope?.exceedsCap && !extendedLookbackAck}
              onClick={() =>
                backfillMutation.mutate({
                  startDate: backfillDate,
                  acknowledgeExtendedLookback: backfillScope?.exceedsCap ? extendedLookbackAck : undefined,
                })
              }
              data-testid="button-confirm-backfill"
            >
              Abruf starten
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task #1711 — Explizite Bestätigung bei abweichender Summe. */}
      <AlertDialog
        open={mismatchConfirm !== null}
        onOpenChange={open => {
          if (!open) setMismatchConfirm(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-match-mismatch">
          <AlertDialogHeader>
            <AlertDialogTitle>Summe weicht ab — trotzdem zuordnen?</AlertDialogTitle>
            <AlertDialogDescription>
              {mismatchConfirm && (
                <>
                  Die Summe der {mismatchConfirm.count}{" "}
                  {mismatchConfirm.count === 1 ? "gewählten Rechnung" : "gewählten Rechnungen"} (
                  {formatCents(mismatchConfirm.selectedSum)}) stimmt nicht mit dem
                  Zahlbetrag ({formatCents(mismatchConfirm.txAmount)}) überein — Differenz{" "}
                  {formatCents(Math.abs(mismatchConfirm.selectedSum - mismatchConfirm.txAmount))}.
                  Fehl-Zuordnungen einer Sammelzahlung sind mühsam zu korrigieren.
                  Möchtest du die Zuordnung trotzdem vornehmen?
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-mismatch">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (mismatchConfirm) runMatch(mismatchConfirm.txId);
                setMismatchConfirm(null);
              }}
              data-testid="button-confirm-mismatch"
            >
              Trotzdem zuordnen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
