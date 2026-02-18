import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Lock, Unlock, Clock, AlertTriangle, CheckCircle2, Loader2, XCircle, CalendarX, FileX } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMonthClosingStatus, useMonthClosingPreview, useMonthClosingReadiness, useCloseMonth } from "../hooks/use-month-closing";
import { iconSize } from "@/design-system";
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

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

interface MonthClosingSectionProps {
  year: number;
  month: number;
}

export function MonthClosingSection({ year, month }: MonthClosingSectionProps) {
  const { toast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const { data: statusData, isLoading: statusLoading } = useMonthClosingStatus(year, month);
  const { data: readinessData, isLoading: readinessLoading } = useMonthClosingReadiness(
    year, month, !statusLoading && !(statusData?.closing && !statusData.closing.reopenedAt)
  );
  const { data: previewData, isLoading: previewLoading } = useMonthClosingPreview(
    year, month, showPreview
  );
  const closeMutation = useCloseMonth();

  const closing = statusData?.closing;
  const isClosed = closing && !closing.reopenedAt;
  const autoBreaks = previewData?.autoBreaks || [];
  const monthName = MONTH_NAMES[month - 1];

  const isReady = readinessData?.ready ?? false;
  const openAppointments = readinessData?.openAppointments ?? [];
  const hasTimeEntries = readinessData?.hasTimeEntries ?? false;
  const hasBlockers = !readinessLoading && readinessData && !isReady;

  const handleCloseMonth = () => {
    closeMutation.mutate(
      { year, month },
      {
        onSuccess: (data) => {
          setShowConfirm(false);
          setShowPreview(false);
          const msg = data.autoBreaksInserted > 0
            ? `${monthName} ${year} abgeschlossen. ${data.autoBreaksInserted} Auto-Pause(n) ergänzt.`
            : `${monthName} ${year} abgeschlossen.`;
          toast({ title: msg });
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  if (statusLoading) return null;

  return (
    <>
      <Card className="mt-4" data-testid="card-month-closing">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isClosed ? (
                <Lock className={`${iconSize.sm} text-green-600`} />
              ) : (
                <Unlock className={`${iconSize.sm} text-amber-600`} />
              )}
              <CardTitle className="text-base">
                Monatsabschluss {monthName} {year}
              </CardTitle>
            </div>
            {isClosed ? (
              <StatusBadge type="month" value="closed" data-testid="badge-month-closed" />
            ) : (
              <StatusBadge type="month" value="open" data-testid="badge-month-open" />
            )}
          </div>
          {!isClosed && (
            <CardDescription>
              Schliessen Sie den Monat ab, um automatische Pausen zu ergänzen und Einträge zu sperren.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {isClosed ? (
            <p className="text-sm text-muted-foreground">
              Einträge für diesen Monat sind gesperrt. Nur ein Admin kann den Monat wieder öffnen.
            </p>
          ) : readinessLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Prüfe Voraussetzungen...
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {hasBlockers && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3" data-testid="section-month-closing-blockers">
                  <div className="flex items-center gap-2 mb-2">
                    <XCircle className="h-4 w-4 text-red-600 shrink-0" />
                    <span className="text-sm font-medium text-red-800">
                      Monatsabschluss noch nicht möglich
                    </span>
                  </div>

                  {!hasTimeEntries && (
                    <div className="flex items-start gap-2 mt-2 ml-6" data-testid="blocker-no-time-entries">
                      <FileX className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-red-700">
                        Keine Zeiteinträge für diesen Monat vorhanden. Bitte erfassen Sie Ihre Arbeitszeiten.
                      </p>
                    </div>
                  )}

                  {openAppointments.length > 0 && (
                    <div className="mt-2 ml-6" data-testid="blocker-open-appointments">
                      <div className="flex items-start gap-2">
                        <CalendarX className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm text-red-700 mb-1">
                            {openAppointments.length} offene(r) Termin(e) müssen abgeschlossen oder storniert werden:
                          </p>
                          <div className="flex flex-col gap-1">
                            {openAppointments.map((apt) => (
                              <div key={apt.id} className="flex items-center justify-between text-xs text-red-600 bg-red-100/50 rounded px-2 py-1">
                                <span>{formatDate(apt.date)} {apt.scheduledStart?.slice(0, 5)}</span>
                                <span className="truncate ml-2">{apt.customerName}</span>
                                <StatusBadge type="appointment" value={apt.status} className="ml-2 text-[10px]" />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isReady && (
                <>
                  {!showPreview ? (
                    <Button
                      variant="outline"
                      onClick={() => setShowPreview(true)}
                      data-testid="button-preview-closing"
                    >
                      <Clock className={`${iconSize.sm} mr-2`} />
                      Vorschau anzeigen
                    </Button>
                  ) : previewLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Vorschau wird geladen...
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {autoBreaks.length > 0 ? (
                        <div className="rounded-md border p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                            <span className="text-sm font-medium">
                              {autoBreaks.length} fehlende Pause(n) werden ergänzt:
                            </span>
                          </div>
                          <div className="flex flex-col gap-1">
                            {autoBreaks.map((b) => (
                              <div key={b.date} className="flex items-center justify-between text-sm text-muted-foreground">
                                <span>{formatDate(b.date)}</span>
                                <span>
                                  {b.autoBreakMinutes} Min Pause ({Math.round(b.totalWorkMinutes / 60 * 10) / 10}h Arbeit)
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-sm text-green-600">
                          <CheckCircle2 className="h-4 w-4" />
                          Alle Pausen korrekt erfasst. Keine automatischen Ergänzungen nötig.
                        </div>
                      )}
                      <Button
                        className="bg-teal-600 hover:bg-teal-700"
                        onClick={() => setShowConfirm(true)}
                        data-testid="button-close-month"
                      >
                        <Lock className={`${iconSize.sm} mr-2`} />
                        Monat abschliessen
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {monthName} {year} abschliessen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {autoBreaks.length > 0
                ? `Es werden ${autoBreaks.length} automatische Pause(n) ergänzt. Danach können Sie keine Einträge mehr bearbeiten. Nur ein Admin kann den Monat wieder öffnen.`
                : "Danach können Sie keine Einträge mehr bearbeiten. Nur ein Admin kann den Monat wieder öffnen."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-close">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal-600 hover:bg-teal-700"
              onClick={handleCloseMonth}
              disabled={closeMutation.isPending}
              data-testid="button-confirm-close"
            >
              {closeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Abschliessen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatDate(isoDate: string): string {
  const parts = isoDate.split("-");
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}
