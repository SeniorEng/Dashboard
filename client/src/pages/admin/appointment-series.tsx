import { useState, useEffect, useRef } from "react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
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
import { ChevronLeft, Repeat, Calendar, User, Clock, ArrowRight, Loader2, CalendarPlus, CalendarMinus, XCircle } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useLocation, Link } from "wouter";
import {
  useAppointmentSeriesList,
  useExtendSeries,
  useShortenSeries,
  useEndSeries,
  formatWeekdays,
  WEEKDAY_LABELS,
} from "@/features/appointments/hooks/use-appointment-series";

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function AdminAppointmentSeries() {
  const [, setLocation] = useLocation();
  const { data: seriesList = [], isLoading } = useAppointmentSeriesList();
  const extendMutation = useExtendSeries();
  const shortenMutation = useShortenSeries();
  const endMutation = useEndSeries();

  const highlightId = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("id")
    : null;
  const highlightSeriesId = highlightId ? parseInt(highlightId) : null;
  const highlightRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);

  useEffect(() => {
    if (highlightRef.current && !hasScrolled.current && !isLoading) {
      hasScrolled.current = true;
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [isLoading, seriesList]);

  const [actionDialog, setActionDialog] = useState<{
    type: "extend" | "shorten" | "end";
    seriesId: number;
    seriesName: string;
  } | null>(null);
  const [newEndDate, setNewEndDate] = useState<string>("");

  const handleAction = () => {
    if (!actionDialog) return;

    if (actionDialog.type === "end") {
      endMutation.mutate(actionDialog.seriesId, {
        onSuccess: () => setActionDialog(null),
      });
    } else if (actionDialog.type === "extend" && newEndDate) {
      extendMutation.mutate(
        { id: actionDialog.seriesId, newEndDate },
        { onSuccess: () => { setActionDialog(null); setNewEndDate(""); } },
      );
    } else if (actionDialog.type === "shorten" && newEndDate) {
      shortenMutation.mutate(
        { id: actionDialog.seriesId, newEndDate },
        { onSuccess: () => { setActionDialog(null); setNewEndDate(""); } },
      );
    }
  };

  const activeSeries = seriesList.filter(s => s.status === "active");
  const endedSeries = seriesList.filter(s => s.status !== "active");

  const grouped = activeSeries.reduce((acc, s) => {
    const name = s.customerName || `Kunde #${s.customerId}`;
    if (!acc[name]) acc[name] = [];
    acc[name].push(s);
    return acc;
  }, {} as Record<string, typeof activeSeries>);

  const isPending = extendMutation.isPending || shortenMutation.isPending || endMutation.isPending;

  return (
    <Layout variant="admin">
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation("/admin")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <div className="flex items-center gap-3">
          <Repeat className={`${iconSize.lg} text-primary`} />
          <h1 className={componentStyles.pageTitle}>Serientermine</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Übersicht aller aktiven Terminserien, gruppiert nach Kunde
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      ) : activeSeries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Repeat className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground">Keine aktiven Terminserien vorhanden</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, "de")).map(([customerName, series]) => (
            <Card key={customerName} data-testid={`card-customer-series-${customerName}`}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <User className={`${iconSize.sm} text-primary`} />
                  {customerName}
                  <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                    {series.length} {series.length === 1 ? "Serie" : "Serien"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {series.map((s) => (
                  <div
                    key={s.id}
                    ref={highlightSeriesId === s.id ? highlightRef : undefined}
                    className={`p-3 rounded-lg border bg-card hover:shadow-sm transition-shadow ${highlightSeriesId === s.id ? "ring-2 ring-primary ring-offset-2" : ""}`}
                    data-testid={`card-series-${s.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex gap-1">
                            {(s.weekdays || []).map((d: string) => (
                              <span
                                key={d}
                                className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 text-primary text-xs font-semibold"
                              >
                                {WEEKDAY_LABELS[d] || d}
                              </span>
                            ))}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {s.frequency === "biweekly" ? "alle 2 Wochen" : "wöchentlich"}
                          </span>
                        </div>

                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {s.scheduledStart?.slice(0, 5)} Uhr · {s.durationMinutes} Min.
                          </span>
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {formatDate(s.startDate)} – {formatDate(s.endDate)}
                          </span>
                        </div>

                        {s.employeeName && (
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {s.employeeName}
                          </div>
                        )}

                        <div className="text-xs text-muted-foreground" data-testid={`remaining-count-${s.id}`}>
                          {s.remainingCount ?? 0} verbleibende Termine
                        </div>
                      </div>

                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          onClick={() => {
                            setActionDialog({ type: "extend", seriesId: s.id, seriesName: customerName });
                            setNewEndDate("");
                          }}
                          data-testid={`button-extend-${s.id}`}
                        >
                          <CalendarPlus className="w-3.5 h-3.5 mr-1" />
                          Verlängern
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          onClick={() => {
                            setActionDialog({ type: "shorten", seriesId: s.id, seriesName: customerName });
                            setNewEndDate("");
                          }}
                          data-testid={`button-shorten-${s.id}`}
                        >
                          <CalendarMinus className="w-3.5 h-3.5 mr-1" />
                          Verkürzen
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => setActionDialog({ type: "end", seriesId: s.id, seriesName: customerName })}
                          data-testid={`button-end-${s.id}`}
                        >
                          <XCircle className="w-3.5 h-3.5 mr-1" />
                          Beenden
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {endedSeries.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Beendete Serien ({endedSeries.length})
              </h2>
              <Card>
                <CardContent className="divide-y">
                  {endedSeries.map((s) => (
                    <div key={s.id} className="py-3 flex items-center justify-between text-sm opacity-60" data-testid={`card-ended-series-${s.id}`}>
                      <div>
                        <span className="font-medium">{s.customerName || `Kunde #${s.customerId}`}</span>
                        <span className="text-muted-foreground ml-2">
                          {formatWeekdays(s.weekdays || [])} · {formatDate(s.startDate)} – {formatDate(s.endDate)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">Beendet</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={!!actionDialog} onOpenChange={(open) => { if (!open) setActionDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {actionDialog?.type === "extend" && <CalendarPlus className={`${iconSize.md} text-primary`} />}
              {actionDialog?.type === "shorten" && <CalendarMinus className={`${iconSize.md} text-amber-600`} />}
              {actionDialog?.type === "end" && <XCircle className={`${iconSize.md} text-destructive`} />}
              {actionDialog?.type === "extend" && "Serie verlängern"}
              {actionDialog?.type === "shorten" && "Serie verkürzen"}
              {actionDialog?.type === "end" && "Serie beenden"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actionDialog?.type === "end"
                ? `Möchten Sie die Serie für "${actionDialog?.seriesName}" wirklich beenden? Alle zukünftigen Termine werden abgesagt.`
                : `Neues Enddatum für die Serie "${actionDialog?.seriesName}" wählen:`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>

          {actionDialog?.type !== "end" && (
            <div className="py-4">
              <DatePicker
                value={newEndDate || null}
                onChange={(val) => setNewEndDate(val || "")}
                data-testid="input-series-new-end-date"
              />
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAction}
              disabled={isPending || (actionDialog?.type !== "end" && !newEndDate)}
              className={actionDialog?.type === "end" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {actionDialog?.type === "extend" && "Verlängern"}
              {actionDialog?.type === "shorten" && "Verkürzen"}
              {actionDialog?.type === "end" && "Serie beenden"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
