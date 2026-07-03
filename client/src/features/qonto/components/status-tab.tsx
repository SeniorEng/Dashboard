import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { iconSize } from "@/design-system";
import { RefreshCw, Loader2, CheckCircle2, XCircle, Landmark } from "lucide-react";
import { formatDate } from "../utils";
import { useSyncMutation } from "../hooks";
import type { QontoStatus } from "../types";

export function StatusTab({ status, isLoading }: { status?: QontoStatus; isLoading: boolean }) {
  const syncMutation = useSyncMutation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  const configured = status?.configured ?? false;
  const connected = status?.connection?.success ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className={iconSize.sm} />
            Verbindungsstatus
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!configured ? (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <XCircle className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-amber-800">Nicht konfiguriert</p>
                <p className="text-xs text-amber-700 mt-1">
                  Bitte hinterlegen Sie die Qonto-Zugangsdaten unter Einstellungen → Qonto-Verbindung (Login, Secret Key und IBAN).
                </p>
              </div>
            </div>
          ) : connected ? (
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
              <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-green-800">Verbunden</p>
                {status?.connection?.bankAccountName && (
                  <p className="text-xs text-green-700 mt-1">{status.connection.bankAccountName}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
              <XCircle className={`${iconSize.sm} text-red-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-red-800">Verbindung fehlgeschlagen</p>
                <p className="text-xs text-red-700 mt-1">{status?.connection?.error}</p>
              </div>
            </div>
          )}

          {configured && (status?.connection?.accounts?.length ?? 0) > 0 && (
            <div className="space-y-2" data-testid="list-qonto-accounts">
              <p className="text-xs font-medium text-gray-600">Überwachte Konten</p>
              {status!.connection!.accounts!.map((acc) => (
                <div
                  key={acc.iban}
                  className="flex items-center gap-2 text-xs"
                  data-testid={`account-status-${acc.iban.slice(-4)}`}
                >
                  {acc.success ? (
                    <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0`} />
                  ) : (
                    <XCircle className={`${iconSize.sm} text-red-600 shrink-0`} />
                  )}
                  <span className="font-mono text-gray-700">…{acc.iban.slice(-4)}</span>
                  {!acc.success && acc.error && (
                    <span className="text-red-600 truncate">{acc.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {status?.lastSync && (
            <p className="text-xs text-gray-500">
              Letzter Sync: {formatDate(status.lastSync)} um {new Date(status.lastSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}

          {configured && (
            <Button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
