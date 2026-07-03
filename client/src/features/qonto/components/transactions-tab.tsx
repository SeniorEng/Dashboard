import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
import { Loader2, Link2, Unlink, Upload, Zap, RefreshCw, History, Ban, RotateCcw } from "lucide-react";
import { formatCents, formatDate } from "../utils";
import {
  useQontoTransactions,
  useMatchableInvoices,
  useTransactionMutations,
  useSyncMutation,
  useBackfillMutation,
} from "../hooks";
import type { MatchFilter } from "../types";

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

  const transactionsQuery = useQontoTransactions(matchFilter, configured);
  const invoicesQuery = useMatchableInvoices(matchingTxId !== null);

  const syncMutation = useSyncMutation();
  const backfillMutation = useBackfillMutation();

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
        <p className="text-xs text-gray-500" data-testid="text-last-sync">
          {lastSync
            ? `Letzter Sync: ${formatDate(lastSync)} um ${new Date(lastSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
            : "Noch nicht synchronisiert"}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || backfillMutation.isPending}
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
          <Button
            variant="outline"
            onClick={() => setBackfillConfirmOpen(true)}
            disabled={syncMutation.isPending || backfillMutation.isPending}
            className="w-full sm:w-auto"
            data-testid="button-backfill"
            title="Zieht die komplette Historie der nachträglich ergänzten Zusatzkonten ohne Zeitfenster."
          >
            {backfillMutation.isPending ? (
              <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
            ) : (
              <History className={`${iconSize.sm} mr-2`} />
            )}
            Voll-Sync Zusatzkonten
          </Button>
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

      <AlertDialog open={backfillConfirmOpen} onOpenChange={setBackfillConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Voll-Sync Zusatzkonten starten?</AlertDialogTitle>
            <AlertDialogDescription>
              Dies ist ein einmaliger Voll-Abzug: Die komplette Historie der
              nachträglich ergänzten Zusatzkonten wird ohne Zeitfenster geladen
              (mehrere Qonto-API-Seiten, ggf. viele Transaktionen). Der Vorgang
              kann etwas dauern und ist keine reguläre Sync-Aktion. Für den
              Regelbetrieb bitte „Jetzt synchronisieren" verwenden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-backfill">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => backfillMutation.mutate()}
              data-testid="button-confirm-backfill"
            >
              Voll-Sync starten
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
