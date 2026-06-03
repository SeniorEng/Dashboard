import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Wrench, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";

export function BackfillBudgetCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<{ total: number; created: number; skipped: number; errors: number } | null>(null);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ total: number; created: number; skipped: number; errors: number }>("/admin/budget/backfill-transactions", {});
      return unwrapResult(res);
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: `${data.created} Budget-Buchungen nachgetragen`, description: `${data.total} Termine geprüft, ${data.skipped} übersprungen, ${data.errors} Fehler` });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-backfill-budget">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className={iconSize.sm} />
          Wartung: Budget-Nachbuchung
        </CardTitle>
        <CardDescription>
          Importierte Termine, die keine Budget-Abbuchung haben, werden nachträglich gebucht.
          Betrifft abgeschlossene Termine ohne zugehörige Budget-Transaktion.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
          variant="outline"
          data-testid="button-backfill-budget"
        >
          {backfillMutation.isPending ? (
            <><Loader2 className={`${iconSize.sm} animate-spin mr-2`} />Wird verarbeitet...</>
          ) : (
            "Budget-Buchungen nachtragen"
          )}
        </Button>
        {result && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm space-y-1">
            <p><strong>{result.total}</strong> Termine ohne Budget-Buchung gefunden</p>
            <p className="text-green-700"><strong>{result.created}</strong> Buchungen erfolgreich erstellt</p>
            {result.skipped > 0 && <p className="text-gray-600"><strong>{result.skipped}</strong> übersprungen</p>}
            {result.errors > 0 && <p className="text-red-600"><strong>{result.errors}</strong> Fehler (z.B. fehlende Preisvereinbarungen)</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface RepairResult {
  totalOrphaned: number;
  totalDuplicates: number;
  executed: boolean;
  orphanedConsumptions: { transactionId: number; appointmentId: number | null; customerId: number; euroAmount: string; budgetType: string }[];
  duplicateReversals: { transactionId: number; reversedTransactionId: number; customerId: number }[];
  reversedCount?: number;
  deletedDuplicates?: number;
  errors?: { txId: number; error: string }[];
}

export function RepairOrphanedTransactionsCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<RepairResult | null>(null);

  const checkMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<RepairResult>("/budget/admin/repair-orphaned-transactions", {});
      return unwrapResult(res);
    },
    onSuccess: (data) => {
      setResult(data);
      if (data.totalOrphaned === 0 && data.totalDuplicates === 0) {
        toast({ title: "Alles in Ordnung", description: "Keine verwaisten oder doppelten Budget-Buchungen gefunden." });
      } else {
        toast({ title: "Probleme gefunden", description: `${data.totalOrphaned} verwaiste, ${data.totalDuplicates} doppelte Buchungen`, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const repairMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<RepairResult>("/budget/admin/repair-orphaned-transactions?execute=true", {});
      return unwrapResult(res);
    },
    onSuccess: (data) => {
      setResult(data);
      const errorCount = data.errors?.length ?? 0;
      toast({
        title: "Reparatur abgeschlossen",
        description: `${data.reversedCount ?? 0} storniert, ${data.deletedDuplicates ?? 0} Duplikate entfernt${errorCount > 0 ? `, ${errorCount} Fehler` : ""}`,
        variant: errorCount > 0 ? "destructive" : "default",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const isPending = checkMutation.isPending || repairMutation.isPending;
  const hasProblems = result && (result.totalOrphaned > 0 || result.totalDuplicates > 0) && !result.executed;

  return (
    <Card data-testid="card-repair-orphaned">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className={iconSize.sm} />
          Wartung: Budget-Reparatur
        </CardTitle>
        <CardDescription>
          Findet verwaiste Budget-Abbuchungen (Termin gelöscht, aber Abbuchung nicht storniert)
          und doppelte Stornierungen. Prüfung zuerst, Reparatur nur auf Knopfdruck.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3">
          <Button
            onClick={() => { setResult(null); checkMutation.mutate(); }}
            disabled={isPending}
            variant="outline"
            data-testid="button-check-orphaned"
          >
            {checkMutation.isPending ? (
              <><Loader2 className={`${iconSize.sm} animate-spin mr-2`} />Wird geprüft...</>
            ) : (
              "Prüfen"
            )}
          </Button>
          {hasProblems && (
            <Button
              onClick={() => repairMutation.mutate()}
              disabled={isPending}
              variant="destructive"
              data-testid="button-repair-orphaned"
            >
              {repairMutation.isPending ? (
                <><Loader2 className={`${iconSize.sm} animate-spin mr-2`} />Wird repariert...</>
              ) : (
                `${result.totalOrphaned + result.totalDuplicates} Probleme beheben`
              )}
            </Button>
          )}
        </div>
        {result && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm space-y-2">
            {result.totalOrphaned === 0 && result.totalDuplicates === 0 && !result.executed && (
              <p className="text-green-700 font-medium">Keine Probleme gefunden.</p>
            )}
            {result.totalOrphaned > 0 && (
              <div>
                <p className="font-medium">{result.totalOrphaned} verwaiste Abbuchung(en):</p>
                <ul className="ml-4 mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {result.orphanedConsumptions.slice(0, 10).map((oc) => (
                    <li key={oc.transactionId}>
                      Txn #{oc.transactionId} — Kunde {oc.customerId}, Termin {oc.appointmentId ?? "gelöscht"}, {oc.euroAmount} € ({oc.budgetType})
                    </li>
                  ))}
                  {result.totalOrphaned > 10 && <li>… und {result.totalOrphaned - 10} weitere</li>}
                </ul>
              </div>
            )}
            {result.totalDuplicates > 0 && (
              <div>
                <p className="font-medium text-amber-700">{result.totalDuplicates} doppelte Stornierung(en)</p>
              </div>
            )}
            {result.executed && (
              <div className="border-t pt-2 mt-2">
                <p className="text-green-700"><strong>{result.reversedCount ?? 0}</strong> Abbuchungen storniert</p>
                <p className="text-green-700"><strong>{result.deletedDuplicates ?? 0}</strong> Duplikate entfernt</p>
                {(result.errors?.length ?? 0) > 0 && (
                  <div className="mt-1">
                    <p className="text-red-600 font-medium">{result.errors!.length} Fehler:</p>
                    <ul className="ml-4 text-xs text-red-600">
                      {result.errors!.map((e) => (
                        <li key={e.txId}>Txn #{e.txId}: {e.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
