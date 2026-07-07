import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Loader2, Link2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatCents, formatDate } from "../utils";
import { useAmbiguousAdvices, useResolveAmbiguousAdviceMutation } from "../hooks";
import type { AmbiguousAdvice, AmbiguousAdviceCredit } from "../types";

function reasonLabel(reason: AmbiguousAdvice["reason"]): string {
  return reason === "credit_collision"
    ? "Gutschrift von mehreren Avisen beansprucht"
    : "Mehrere passende Gutschriften";
}

function daysDeltaLabel(daysDelta: number): string {
  const sign = daysDelta > 0 ? "+" : "";
  return `${sign}${daysDelta} Tag${Math.abs(daysDelta) === 1 ? "" : "e"} zum Anker`;
}

export function AmbiguousAdvicesTab({ configured }: { configured: boolean }) {
  const [pending, setPending] = useState<{ advice: AmbiguousAdvice; credit: AmbiguousAdviceCredit } | null>(null);

  const ambiguousQuery = useAmbiguousAdvices(configured);
  const resolveMutation = useResolveAmbiguousAdviceMutation();

  if (!configured) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-gray-500">
          Bitte zuerst die Qonto-Zugangsdaten unter Einstellungen → Qonto-Verbindung hinterlegen (Login, Secret Key und IBAN).
        </CardContent>
      </Card>
    );
  }

  const advices = ambiguousQuery.data?.ambiguous ?? [];

  const handleConfirm = () => {
    if (!pending) return;
    resolveMutation.mutate(
      { adviceId: pending.advice.adviceId, txId: pending.credit.txId },
      { onSuccess: () => setPending(null) },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className={`${iconSize.md} text-amber-600 mt-0.5 shrink-0`} />
        <p className="text-sm text-gray-600">
          Diese vollständig bezahlten Sammel-Avise lassen sich keiner Sammelzahlung eindeutig
          zuordnen — entweder passen mehrere Gutschriften, oder mehrere Avise beanspruchen dieselbe
          Gutschrift. Wählen Sie je Avis die richtige Gutschrift aus; die Verknüpfung wird
          revisionssicher protokolliert.
        </p>
      </div>

      {ambiguousQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : advices.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center" data-testid="text-no-ambiguous">
            <CheckCircle2 className={`${iconSize.md} text-green-600 mx-auto mb-2`} />
            <p className="text-sm text-gray-500">
              Keine mehrdeutigen Zuordnungen. Alle Sammel-Avise sind eindeutig oder bereits zugeordnet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {advices.map(advice => (
            <Card key={advice.adviceId} data-testid={`ambiguous-advice-${advice.adviceId}`}>
              <CardHeader className="pb-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                      <span data-testid={`ambiguous-advice-number-${advice.adviceId}`}>
                        Avis {advice.avisNummer ?? `#${advice.adviceId}`}
                      </span>
                      <Badge
                        variant="outline"
                        className="bg-amber-50 text-amber-700 border-amber-200 text-xs"
                        data-testid={`ambiguous-advice-reason-${advice.adviceId}`}
                      >
                        {reasonLabel(advice.reason)}
                      </Badge>
                    </CardTitle>
                    <p className="text-xs text-gray-600 mt-1" data-testid={`ambiguous-advice-meta-${advice.adviceId}`}>
                      {formatCents(advice.adviceAmountCents)}
                      {" · "}
                      {advice.invoiceCount} Rechnung{advice.invoiceCount === 1 ? "" : "en"}
                      {advice.anchorDate && ` · Anker ${formatDate(advice.anchorDate)}`}
                      {advice.kostentraegerName && ` · ${advice.kostentraegerName}`}
                    </p>
                    {advice.adviceIban && (
                      <p className="text-xs text-gray-500 mt-0.5 font-mono" data-testid={`ambiguous-advice-iban-${advice.adviceId}`}>
                        Empfänger-IBAN …{advice.adviceIban.slice(-4)}
                      </p>
                    )}
                    {advice.reason === "credit_collision" && advice.collidingAdviceIds.length > 0 && (
                      <p className="text-xs text-amber-700 mt-0.5" data-testid={`ambiguous-advice-colliding-${advice.adviceId}`}>
                        Konkurriert mit Avis {advice.collidingAdviceIds.map(id => `#${id}`).join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs font-medium text-gray-600">
                  Konkurrierende Gutschrift{advice.candidates.length === 1 ? "" : "en"} wählen:
                </p>
                {advice.candidates.map(credit => (
                  <div
                    key={credit.txId}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border px-3 py-2"
                    data-testid={`ambiguous-credit-${advice.adviceId}-${credit.txId}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{formatCents(credit.txAmountCents)}</span>
                        <span className="text-xs text-gray-500">{formatDate(credit.txEmittedAt)}</span>
                        <Badge variant="outline" className="text-xs bg-gray-50 text-gray-600 border-gray-200">
                          {daysDeltaLabel(credit.daysDelta)}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-xs ${credit.nameMatchesAdvisory ? "bg-teal-50 text-teal-700 border-teal-200" : "bg-gray-50 text-gray-500 border-gray-200"}`}
                          data-testid={`ambiguous-credit-name-${advice.adviceId}-${credit.txId}`}
                        >
                          Name {credit.nameMatchesAdvisory ? "≈ passt" : "≠ nur Kontext"}
                        </Badge>
                      </div>
                      {credit.txCounterpartyName && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate">{credit.txCounterpartyName}</p>
                      )}
                      {credit.txSourceIban && (
                        <p className="text-xs text-gray-500 mt-0.5 font-mono">
                          Quell-IBAN …{credit.txSourceIban.slice(-4)}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 border-teal-300 text-teal-700 hover:bg-teal-100"
                        onClick={() => setPending({ advice, credit })}
                        disabled={resolveMutation.isPending}
                        data-testid={`button-resolve-${advice.adviceId}-${credit.txId}`}
                      >
                        <Link2 className={`${iconSize.sm} mr-1`} />
                        Zuordnen
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={pending !== null} onOpenChange={open => !open && setPending(null)}>
        <AlertDialogContent data-testid="dialog-resolve-ambiguous">
          <AlertDialogHeader>
            <AlertDialogTitle>Zuordnung bestätigen</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && (
                <>
                  Avis <strong>{pending.advice.avisNummer ?? `#${pending.advice.adviceId}`}</strong>{" "}
                  ({formatCents(pending.advice.adviceAmountCents)}) wird mit der Gutschrift über{" "}
                  <strong>{formatCents(pending.credit.txAmountCents)}</strong> vom{" "}
                  {formatDate(pending.credit.txEmittedAt)}
                  {pending.credit.txCounterpartyName && ` (${pending.credit.txCounterpartyName})`} verknüpft.
                  Diese Zuordnung wird revisionssicher protokolliert.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-resolve">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={resolveMutation.isPending}
              data-testid="button-confirm-resolve"
            >
              {resolveMutation.isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
              Zuordnen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
