import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { iconSize } from "@/design-system";
import { Loader2, Link2, Unlink, Upload, Zap } from "lucide-react";
import { formatCents, formatDate } from "../utils";
import { useQontoTransactions, useMatchableInvoices, useTransactionMutations } from "../hooks";
import type { MatchFilter } from "../types";

export function TransactionsTab({
  configured,
  matchFilter,
  onFilterChange,
}: {
  configured: boolean;
  matchFilter: MatchFilter;
  onFilterChange: (v: MatchFilter) => void;
}) {
  const [matchingTxId, setMatchingTxId] = useState<number | null>(null);

  const transactionsQuery = useQontoTransactions(matchFilter, configured);

  const invoicesQuery = useMatchableInvoices(matchingTxId !== null);

  const { matchMutation, unmatchMutation, autoMatchMutation, csvImportMutation } = useTransactionMutations({
    onMatchSuccess: () => setMatchingTxId(null),
  });

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
          Bitte zuerst die Qonto-Verbindung einrichten.
        </CardContent>
      </Card>
    );
  }

  const transactions = transactionsQuery.data?.transactions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Select value={matchFilter} onValueChange={v => onFilterChange(v as MatchFilter)}>
          <SelectTrigger className="w-[200px]" data-testid="select-match-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Transaktionen</SelectItem>
            <SelectItem value="unmatched">Offen (ohne Zuordnung)</SelectItem>
            <SelectItem value="matched">Zugeordnet</SelectItem>
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
                      {tx.matchedInvoiceId ? (
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
                    {tx.matchedInvoiceId ? (
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
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setMatchingTxId(matchingTxId === tx.id ? null : tx.id)}
                        aria-label="Rechnung zuordnen"
                        data-testid={`button-match-${tx.id}`}
                      >
                        <Link2 className={iconSize.sm} />
                      </Button>
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
    </div>
  );
}
