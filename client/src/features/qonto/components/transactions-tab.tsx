import { useMemo, useState } from "react";
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
import { Loader2, Link2, Unlink, Upload, Zap, RefreshCw, History, Ban, RotateCcw, Plus, Trash2, EyeOff } from "lucide-react";
import { formatCents, formatDate } from "../utils";
import {
  useQontoTransactions,
  useMatchableInvoices,
  useTransactionMutations,
  useSyncMutation,
  useBackfillMutation,
  useQontoBackfillStatus,
  useQontoHideRules,
  useHideRuleMutations,
} from "../hooks";
import { Checkbox } from "@/components/ui/checkbox";
import type { MatchFilter } from "../types";
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
}: {
  configured: boolean;
  matchFilter: MatchFilter;
  onFilterChange: (v: MatchFilter) => void;
  lastSync?: string | null;
}) {
  const [matchingTxId, setMatchingTxId] = useState<number | null>(null);
  const [backfillConfirmOpen, setBackfillConfirmOpen] = useState(false);
  const [backfillDate, setBackfillDate] = useState(DEFAULT_BACKFILL_START);
  const [extendedLookbackAck, setExtendedLookbackAck] = useState(false);
  const backfillScope = useMemo(() => estimateBackfillScope(backfillDate), [backfillDate]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [newRuleType, setNewRuleType] = useState<"counterparty" | "iban">("counterparty");
  const [newRuleValue, setNewRuleValue] = useState("");

  const transactionsQuery = useQontoTransactions(matchFilter, configured);
  const invoicesQuery = useMatchableInvoices(matchingTxId !== null);
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

  const {
    matchMutation,
    unmatchMutation,
    autoMatchMutation,
    csvImportMutation,
    ignoreMutation,
    unignoreMutation,
  } = useTransactionMutations({ onMatchSuccess: () => setMatchingTxId(null) });

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

  const transactions = transactionsQuery.data?.transactions ?? [];

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
            <Card key={tx.id} data-testid={`transaction-card-${tx.id}`}>
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
                      ) : tx.matchedInvoiceId ? (
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs" data-testid={`badge-matched-${tx.id}`}>
                          Zugeordnet
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs" data-testid={`badge-unmatched-${tx.id}`}>
                          Offen
                        </Badge>
                      )}
                      {tx.matchConfidence && (
                        <span className="text-xs text-gray-500">
                          ({tx.matchConfidence === "manual" ? "manuell" : "automatisch"})
                        </span>
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
                    ) : tx.matchedInvoiceId ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => unmatchMutation.mutate(tx.id)}
                        disabled={unmatchMutation.isPending}
                        aria-label="Zuordnung aufheben"
                        data-testid={`button-unmatch-${tx.id}`}
                      >
                        <Unlink className={iconSize.sm} />
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setMatchingTxId(matchingTxId === tx.id ? null : tx.id)}
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

                {matchingTxId === tx.id && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <Label className="text-xs font-medium text-gray-600">Rechnung zuordnen</Label>
                    {invoicesQuery.isLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin`} />
                    ) : (
                      <Select
                        onValueChange={v => matchMutation.mutate({ txId: tx.id, invoiceId: parseInt(v) })}
                      >
                        <SelectTrigger data-testid={`select-invoice-${tx.id}`}>
                          <SelectValue placeholder="Rechnung wählen..." />
                        </SelectTrigger>
                        <SelectContent>
                          {(invoicesQuery.data ?? []).map(inv => (
                            <SelectItem key={inv.id} value={inv.id.toString()}>
                              {inv.invoiceNumber} — {inv.customerName} — {formatCents(inv.grossAmountCents)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
    </div>
  );
}
