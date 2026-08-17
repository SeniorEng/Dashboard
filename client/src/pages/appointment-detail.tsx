import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment, useAppointmentBudgetFit } from "@/features/appointments";
import { useDeleteAppointment, useDecoupleCoVisit, useRestoreAppointment } from "@/features/appointments/hooks";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { SectionCard } from "@/components/patterns/section-card";
import { iconSize, componentStyles } from "@/design-system";
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
import {
  FileText, ChevronLeft, Loader2,
  Pencil, Trash2, AlertTriangle, RotateCcw, Copy, Repeat, ArrowRight, Users,
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useAppointmentSeriesDetail, formatSeriesInfo } from "@/features/appointments/hooks/use-appointment-series";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult, ApiError } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useAppointmentPolicy } from "@/features/appointments/use-appointment-policy";
import {
  AppointmentDocumentationDiagnosis,
  AppointmentTimeServicesCard,
  AppointmentTravelCard,
  AppointmentServiceRecordCard,
  AppointmentSeriesDeleteDialog,
  AppointmentCustomerHeader,
} from "@/features/appointments/components";

type AppointmentService = {
  id: number;
  serviceId: number;
  serviceName: string;
  serviceCode: string;
  serviceUnitType: string;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
};

export default function AppointmentDetail() {
  const [, params] = useRoute("/appointment/:id");
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const fromParam = new URLSearchParams(searchString).get("from");
  const fromUrl = fromParam ? decodeURIComponent(fromParam) : null;
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;
  const canConvert = user?.isAdmin || user?.roles?.includes("erstberatung");

  const [showReopenDialog, setShowReopenDialog] = useState(false);
  const [showSeriesDeleteDialog, setShowSeriesDeleteDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const reopenMutation = useMutation({
    mutationFn: async (_preReopenStatus: string) => {
      const result = await api.post(`/appointments/${id}/reopen`, {});
      return unwrapResult(result);
    },
    onSuccess: (_data, preReopenStatus) => {
      invalidateRelated(queryClient, "appointments");
      toast({ title: "Dokumentation zur Korrektur geöffnet" });
      setShowReopenDialog(false);
      // Task #1757 — ein reopeneter No-Show darf NUR wieder als No-Show
      // geschlossen werden. Wir leiten deshalb gezielt in den No-Show-
      // Dokumentationspfad statt in die reguläre Doku (die Hauswirtschaft +
      // §45b buchen würde). So kann ein No-Show nicht versehentlich zu einem
      // regulären Leistungstermin werden.
      setLocation(
        preReopenStatus === "customer_no_show"
          ? `/document-appointment/${id}/no-show`
          : `/document-appointment/${id}`,
      );
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
      setShowReopenDialog(false);
    },
  });

  const { data: appointment, isLoading } = useAppointment(id);

  // Hook MUSS vor den frühen Returns weiter unten stehen (React-Rules-of-Hooks):
  // bei isLoading→appointment-Wechsel würde sich sonst die Hook-Anzahl ändern.
  const policy = useAppointmentPolicy(user, appointment);

  const seriesId = appointment?.seriesId ?? undefined;
  const { data: seriesDetail } = useAppointmentSeriesDetail(seriesId ?? 0);

  // Task #707 — passt dieser geplante Termin im eigenen Monat noch in das
  // verfügbare §45b-Kontingent? Map enthält nur §45b-aktive Kunden.
  const { data: budgetFit } = useAppointmentBudgetFit(appointment?.customerId ?? null);
  const budgetOverrun = budgetFit?.get(id)?.fitsInMonthlyBudget === false;

  // Task #1736 — Zwei-Kräfte-Einsatz: der Partner-NAME kommt jetzt serverseitig
  // abgeleitet direkt am Termin mit (`coVisitPartnerName`, sichtbar für Admins
  // UND die beteiligte Kraft) und ersetzt das frühere clientseitige Nachladen
  // der Partner-Legs. Genutzt für die Kaskaden-Warnung beim Löschen/Absagen.
  const isCoVisit = !!appointment?.coVisitGroupId;
  const coVisitPartnerNames = appointment?.coVisitPartnerName
    ? [appointment.coVisitPartnerName]
    : [];

  // Absage-Bestätigung (Muster #1883): Der Server verweigert mit 409, wenn eine
  // begonnene Dokumentation verworfen würde, und weist die betroffenen Termine
  // aus. Ohne diesen Dialog sähe der Mitarbeiter nur eine kryptische Blockade —
  // das wäre schlechter als die stille Vernichtung vorher. Erst der zweite
  // Aufruf MIT Flag führt aus.
  const [discardConfirm, setDiscardConfirm] = useState<{
    mode: "single" | "this_and_future" | "all_future";
    anzahl: number;
  } | null>(null);

  const seriesCancelMutation = useMutation({
    mutationFn: async (data: {
      mode: "single" | "this_and_future" | "all_future";
      confirmDiscardDocumentation?: boolean;
    }) => {
      if (!seriesId) throw new Error("Kein Serien-ID");
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${id}/cancel`, data);
      // Auf den CODE prüfen, nicht nur auf 409: die Route wirft seit dem
      // Re-Cut ZWEI verschiedene 409er. `APPOINTMENT_LOCKED` (Termin liegt auf
      // einem unterschriebenen Leistungsnachweis) darf hier NICHT landen —
      // sonst fragt der Dialog nach dem Verwerfen einer Dokumentation, die gar
      // nicht verworfen wird, und der zweite Aufruf mit Flag scheitert erneut:
      // `return null` → `onSuccess` steigt aus → kein Toast, kein Fehler, der
      // Dialog bleibt stehen. Genau die stille Sackgasse, gegen die dieser PR
      // gebaut ist. Alles andere geht über `unwrapResult` in den Fehler-Toast.
      if (!result.success && result.error.code === "CANCEL_DISCARDS_DOCUMENTATION") {
        const betroffene = result.error.details?.appointments;
        // Den darunterliegenden Serien-Dialog schliessen: sonst stehen zwei
        // modale Dialoge uebereinander (Gate-2-Notiz).
        setShowSeriesDeleteDialog(false);
        setDiscardConfirm({
          mode: data.mode,
          anzahl: Array.isArray(betroffene) ? betroffene.length : 1,
        });
        return null;
      }
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      // `null` = Bestätigung nötig, der Dialog ist offen. Kein Erfolgs-Toast,
      // kein Wegnavigieren — sonst verschwände die Rückfrage sofort wieder.
      if (data === null) return;
      invalidateRelated(queryClient, "appointments", "appointment-series");
      // Auch hier keinen stillen Teilerfolg melden — siehe `useEndSeries`.
      const uebersprungen = (data as { uebersprungen?: Array<{ id: number; grund: string }> } | undefined)?.uebersprungen;
      if (uebersprungen && uebersprungen.length > 0) {
        toast({
          title: "Nicht alle Termine abgesagt",
          description:
            `${uebersprungen.length} ${uebersprungen.length === 1 ? "Termin blieb" : "Termine blieben"} bestehen: ` +
            uebersprungen.map(u => u.grund).join(" · "),
          variant: "destructive",
        });
      } else {
        toast({ title: "Serientermine abgesagt" });
      }
      setShowSeriesDeleteDialog(false);
      setDiscardConfirm(null);
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const { data: existingServiceRecord, isLoading: isLoadingServiceRecord } = useQuery<{
    id: number;
    status: string;
  } | null>({
    queryKey: [`/api/service-records/for-appointment/${id}`],
    queryFn: async () => {
      const result = await api.get<{ id: number; status: string } | null>(`/service-records/for-appointment/${id}`);
      return unwrapResult(result);
    },
    enabled: !!id && !!appointment && appointment.status === "completed",
  });

  const createServiceRecordMutation = useMutation({
    mutationFn: async ({ customerId, appointmentId }: { customerId: number; appointmentId: number }) => {
      const result = await api.post<{ id: number }>("/service-records/single", { customerId, appointmentId });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      invalidateRelated(queryClient, "service-records");
      toast({ title: "Leistungsnachweis erstellt" });
      setLocation(`/service-records/${data.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const { data: appointmentServices } = useQuery<AppointmentService[]>({
    queryKey: [`/api/appointments/${id}/services`],
    queryFn: async () => {
      const result = await api.get<AppointmentService[]>(`/appointments/${id}/services`);
      return unwrapResult(result);
    },
    enabled: !!id && !!appointment,
  });

  const deleteMutation = useDeleteAppointment();
  const restoreMutation = useRestoreAppointment();
  // Task #1906 — Ausweg aus dem Löschdialog: statt beide Legs zu entfernen, nur
  // DIESES herauslösen. Der Partner bleibt mit allem, was er hat.
  const decoupleMutation = useDecoupleCoVisit();

  const handleDecouple = useCallback(async () => {
    try {
      await decoupleMutation.mutateAsync({ id });
      toast({
        title: "Einsatz entkoppelt",
        description: "Dieser Termin wurde entfernt. Der Termin der zweiten Kraft bleibt als Einzeltermin bestehen.",
      });
      setShowDeleteDialog(false);
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Der Einsatz konnte nicht entkoppelt werden.";
      const code = error instanceof ApiError ? error.code : undefined;
      // Dieselben zwei fachlichen Reihenfolgen wie beim Löschen — Entkoppeln ist
      // ausdrücklich KEIN Weg um sie herum.
      const title =
        code === "APPOINTMENT_INVOICED" ? "Zuerst die Rechnung erledigen"
        : code === "APPOINTMENT_LOCKED" ? "Termin liegt auf einem unterschriebenen Nachweis"
        : "Fehler";
      toast({ variant: "destructive", title, description: message });
    }
  }, [decoupleMutation, id, toast, setLocation, appointment?.date]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(id);
      toast({
        title: "Termin gelöscht",
        description: "Der Termin wurde erfolgreich gelöscht.",
      });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Der Termin konnte nicht gelöscht werden.";
      // Task #1892 — Zwei fachliche Reihenfolgen, kein technischer Fehler:
      // (1) der Termin hängt an einer aktiven Rechnung → erst die Rechnung
      //     erledigen (Entwurf verwerfen bzw. gestellte Rechnung stornieren —
      //     die genaue Meldung kommt vom Server),
      // (2) Zwei-Kräfte-Einsatz → beide Legs separat behandeln.
      // Beide bekommen einen eigenen, erklärenden Titel statt „Fehler".
      const code = error instanceof ApiError ? error.code : undefined;
      const title =
        code === "APPOINTMENT_INVOICED" ? "Zuerst die Rechnung erledigen"
        : code === "APPOINTMENT_CO_VISIT_LOCKED" ? "Zwei-Kräfte-Einsatz"
        : "Fehler";
      toast({
        variant: "destructive",
        title,
        description: message,
      });
    }
    setShowDeleteDialog(false);
  }, [deleteMutation, id, toast, setLocation, appointment?.date]);

  if (isLoading) {
    return (
      <Layout>
        <div className="py-6 px-4 space-y-4" data-testid="loading-appointment">
          <div className="flex items-center gap-3">
            <div className="animate-pulse h-8 w-8 rounded bg-muted" />
            <div className="animate-pulse h-6 w-40 bg-muted rounded" />
          </div>
          <div className="animate-pulse h-40 w-full bg-muted rounded-xl" />
          <div className="animate-pulse h-24 w-full bg-muted rounded-xl" />
          <div className="animate-pulse h-32 w-full bg-muted rounded-xl" />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <div className="text-center py-12" data-testid="not-found-appointment">
          Termin nicht gefunden
        </div>
      </Layout>
    );
  }

  // Berechtigungen kommen aus shared/policies/appointments — identisch zum Backend.
  // Per-Action-Gating: jede Schaltfläche prüft ihre eigene Policy-Entscheidung,
  // damit z. B. ein Teamleiter, der editieren aber nicht löschen darf, den
  // Bearbeiten-Button trotzdem sieht. `policy` wurde oben (vor den frühen
  // Returns) berechnet, um Rules-of-Hooks einzuhalten.
  const canEdit = policy?.edit.allowed ?? false;
  const canDelete = policy?.delete.allowed ?? false;
  const canDocument = policy?.document.allowed ?? false;
  const canReopen = policy?.reopen.allowed ?? false;
  const isErstberatung = appointment.appointmentType === "Erstberatung";

  const services = appointmentServices || [];
  const isCompleted = appointment.status === "completed";
  const isNoShow = appointment.status === "customer_no_show";
  // Task #1757 — für No-Shows keinen „Bearbeiten"-Knopf: das generische
  // Bearbeiten-Formular zeigt eine irreführende Planungs-/Kostenvorschau und der
  // Server blockt die Änderung ohnehin. Korrektur läuft über „Dokumentation
  // korrigieren" (Reopen → No-Show-Doku).
  const showEdit = canEdit && !isNoShow;

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation(fromUrl ?? (appointment?.date ? `/?date=${appointment.date}` : "/"))}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>

        <div className="mb-4">
          <StatusBadge type="status" value={appointment.status} />
        </div>

        <AppointmentCustomerHeader
          appointment={appointment}
          isAdmin={!!user?.isAdmin}
          isErstberatung={isErstberatung}
          canConvert={!!canConvert}
        />

        {(user?.isAdmin || user?.isTeamLead) && appointment.assignedEmployeeName && (
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-assigned-employee">
            <Users className={`${iconSize.sm} text-primary shrink-0`} />
            <span>
              Zugewiesen: <span className="font-medium text-foreground">{appointment.assignedEmployeeName}</span>
            </span>
            {appointment.assignedEmployeeId === user?.id && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wide"
                data-testid="pill-own-leg-detail"
              >
                Ihr Einsatz
              </span>
            )}
          </div>
        )}

        {appointment.coVisitGroupId && appointment.coVisitPartnerName && (
          <div className="mt-2 p-3 bg-teal-50 border border-teal-200 rounded-lg" data-testid="banner-co-visit">
            <div className="flex items-start gap-2">
              <Users className={`${iconSize.sm} text-teal-600 shrink-0 mt-0.5`} />
              <p className="text-sm text-teal-800">
                Zwei-Kräfte-Einsatz. Die zweite Kraft (Partner) ist{" "}
                <span className="font-medium">{appointment.coVisitPartnerName}</span>.
                {(user?.isAdmin || user?.isTeamLead)
                  && appointment.assignedEmployeeId !== user?.id
                  && !canDocument && (
                  <>
                    {" "}Dies ist nicht Ihr Einsatz — Ihr eigenes Bein trägt Ihren Namen unter „Zugewiesen".
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {seriesId && seriesDetail && (
        <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg" data-testid="banner-series-info">
          <div className="flex items-center gap-2">
            <Repeat className={`${iconSize.sm} text-primary`} />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-primary">Teil einer Serie</span>
              <span className="text-sm text-muted-foreground ml-2">
                {formatSeriesInfo(seriesDetail.series)}
              </span>
            </div>
            {user?.isAdmin && (
              <Link href={`/admin/appointment-series?id=${seriesId}`}>
                <Button variant="ghost" size="sm" className="text-xs text-primary h-7" data-testid="link-series-overview">
                  Zur Serie <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {/*
        Replit-#1913 — Ausweg aus einer Fehlabsage. Nur hier, nicht in der
        Terminliste: Zurückholen ist eine Korrektur, keine Routine-Handlung, und
        soll den Termin vor Augen haben, den sie betrifft.

        Die Policy entscheidet über die Sichtbarkeit; ist sie ablehnend, steht
        statt des Knopfes ihre BEGRÜNDUNG da. Die sagt dem Nutzer, wen er fragen
        muss („die Geschäftsführung muss den Monat wieder öffnen") — genau die
        Auskunft, die im Vorfall gefehlt hat.
      */}
      {appointment.status === "cancelled" && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg" data-testid="banner-cancelled-restore">
          <div className="flex items-center gap-2">
            <AlertTriangle className={`${iconSize.sm} text-amber-600 shrink-0`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-amber-800 font-medium">Dieser Termin ist abgesagt.</p>
              <p className="text-sm text-amber-700">
                {policy?.restore.allowed
                  ? "Wurde er versehentlich abgesagt, obwohl er stattgefunden hat, kann die Absage zurückgenommen werden — der Termin ist danach wieder dokumentierbar."
                  : policy?.restore.reason}
              </p>
            </div>
            {policy?.restore.allowed && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate(appointment.id)}
                data-testid="button-restore-appointment"
              >
                {restoreMutation.isPending ? "Wird zurückgeholt …" : "Absage zurücknehmen"}
              </Button>
            )}
          </div>
        </div>
      )}

      {budgetOverrun && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg" data-testid="banner-budget-overrun">
          <div className="flex items-center gap-2">
            <AlertTriangle className={`${iconSize.sm} text-red-600 shrink-0`} />
            <p className="text-sm text-red-700">
              Dieser Termin überschreitet das verfügbare §45b-Budget in seinem Monat.
            </p>
          </div>
        </div>
      )}

      <AppointmentTimeServicesCard
        appointment={appointment}
        services={services}
        isCompleted={isCompleted}
        isErstberatung={isErstberatung}
      />

      {isCompleted && <AppointmentTravelCard appointment={appointment} />}

      {user?.isAdmin && (() => {
        const isPastScheduled =
          appointment.status === "scheduled" &&
          appointment.date < new Date().toISOString().slice(0, 10);
        const showDiagnose =
          appointment.status === "documenting" ||
          appointment.status === "expired_unsigned" ||
          isPastScheduled;
        return showDiagnose ? (
          <AppointmentDocumentationDiagnosis appointmentId={appointment.id} />
        ) : null;
      })()}

      {appointment.notes && (
        <SectionCard title="Notizen" className="mb-4">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {appointment.notes}
          </p>
        </SectionCard>
      )}

      {isCompleted && !isLoadingServiceRecord && (
        <AppointmentServiceRecordCard
          existingServiceRecord={existingServiceRecord}
          onCreate={() =>
            appointment.customerId &&
            createServiceRecordMutation.mutate({
              customerId: appointment.customerId,
              appointmentId: appointment.id,
            })
          }
          isCreating={createServiceRecordMutation.isPending}
        />
      )}

      {canDocument && (
        <div className="mt-6">
          <Button
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={() => setLocation(`/document-appointment/${appointment.id}`)}
            data-testid="button-document"
            title={policy?.document.allowed ? undefined : policy?.document.reason}
          >
            <FileText className={`${iconSize.sm} mr-2`} />
            Jetzt dokumentieren
          </Button>
        </div>
      )}

      {isCompleted && appointment.isLocked && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          {/* Task #1892 — Für Admins ist der unterschriebene LN keine Sackgasse
              mehr: der Termin kann als Korrektur herausgelöst werden. */}
          {user?.isAdmin ? (
            <p className="text-xs text-amber-700" data-testid="text-locked-info-admin">
              Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises. Bearbeiten ist nicht
              mehr möglich. Als Korrektur können Sie ihn löschen — er wird dann aus dem
              Leistungsnachweis entfernt, der Nachweis bleibt mit beiden Unterschriften gültig.
            </p>
          ) : (
            <p className="text-xs text-amber-700" data-testid="text-locked-info">
              Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.
            </p>
          )}
        </div>
      )}

      {isCompleted && !appointment.isLocked && appointment.isMonthClosed && !user?.isAdmin && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700" data-testid="text-month-closed-info">
            Der Monat ist bereits abgeschlossen. Nur ein Admin kann die Dokumentation noch korrigieren.
          </p>
        </div>
      )}

      {(isCompleted || isNoShow) && canReopen && (
        <div className="mt-6">
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            onClick={() => setShowReopenDialog(true)}
            data-testid="button-reopen"
          >
            <RotateCcw className={`${iconSize.sm} mr-2`} />
            Dokumentation korrigieren
          </Button>
        </div>
      )}

      {(showEdit || canDelete) && (
        <div className="flex gap-3 mt-6">
          {showEdit && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setLocation(`/edit-appointment/${appointment.id}`)}
              data-testid="button-edit"
              title={policy?.edit.reason}
            >
              <Pencil className={`${iconSize.sm} mr-2`} />
              Bearbeiten
            </Button>
          )}
          {canDelete && (
            <Button
              variant="outline"
              className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                if (seriesId) {
                  setShowSeriesDeleteDialog(true);
                } else {
                  setShowDeleteDialog(true);
                }
              }}
              data-testid="button-delete"
              title={policy?.delete.reason}
            >
              <Trash2 className={`${iconSize.sm} mr-2`} />
              Löschen
            </Button>
          )}
        </div>
      )}

      {isCompleted && canDelete && (
        <div className="mt-6">
          <Button
            variant="outline"
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="button-admin-delete"
          >
            <Trash2 className={`${iconSize.sm} mr-2`} />
            Termin löschen (Admin)
          </Button>
        </div>
      )}

      <div className="mt-4">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => setLocation(`/new-appointment?copyFrom=${appointment.id}`)}
          data-testid="button-copy-appointment"
        >
          <Copy className={`${iconSize.sm} mr-2`} />
          Termin kopieren
        </Button>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-destructive`} />
              Termin löschen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCompleted && user?.isAdmin ? (
                <>
                  Möchten Sie den dokumentierten Termin bei <strong>{appointment.customer?.name}</strong> wirklich löschen?
                  Das verbrauchte Budget wird automatisch zurückgebucht.
                  {" "}Diese Aktion kann nicht rückgängig gemacht werden.
                </>
              ) : (
                <>
                  Möchten Sie den Termin bei {appointment.customer?.name} wirklich löschen?
                  Diese Aktion kann nicht rückgängig gemacht werden.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Task #1892 — Admin-Korrektur an einem unterschriebenen LN: erklärt
              in einfacher Sprache, was genau passiert (reduktions-only). */}
          {appointment.isLocked && user?.isAdmin && (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
              data-testid="warning-signed-service-record-delete"
            >
              <FileText className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
              <div className="text-sm text-amber-800 space-y-1">
                <p>
                  Dieser Termin steht auf einem <strong>unterschriebenen Leistungsnachweis</strong>.
                  Er wird daraus entfernt.
                </p>
                <p>
                  Der Leistungsnachweis bleibt gültig — mit beiden Unterschriften, nur mit einem
                  Termin und entsprechend weniger Wert. Das verbrauchte Budget wird zurückgebucht.
                  Enthält der Nachweis danach keinen Termin mehr, wird er entfernt.
                </p>
                <p>
                  Ist der Termin bereits abgerechnet, muss die Rechnung zuerst erledigt werden —
                  ein Entwurf wird verworfen, eine gestellte Rechnung storniert.
                </p>
                {appointment.coVisitGroupId != null && (
                  <p>
                    Dieser Termin ist ein <strong>Zwei-Kräfte-Einsatz</strong>. Kann der Termin der
                    zweiten Kraft nicht mitgelöscht werden — weil er auf einem unterschriebenen
                    Nachweis liegt, abgeschlossen ist oder als „nicht angetroffen“ vermerkt wurde —,
                    wird die Korrektur abgelehnt. Es bliebe sonst ein halber Einsatz stehen.
                  </p>
                )}
              </div>
            </div>
          )}
          {isCoVisit && (
            <div
              className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
              data-testid="warning-co-visit-delete"
            >
              <div className="flex items-start gap-2">
                <Users className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
                <p className="text-sm text-amber-800">
                  Dieser Termin ist Teil eines Zwei-Kräfte-Einsatzes — das Löschen betrifft auch die zweite Kraft
                  {coVisitPartnerNames.length > 0 ? (
                    <> (<strong>{coVisitPartnerNames.join(", ")}</strong>)</>
                  ) : null}
                  . Der Partner-Termin wird ebenfalls entfernt.
                </p>
              </div>
              {/* Task #1906 — der Ausweg. Bis hierher war „beide weg" die einzige
                  Möglichkeit; wer nur eine Kraft herausnehmen wollte, musste
                  löschen und neu anlegen — und verlor dabei den Zustand des
                  anderen Legs. */}
              <div className="flex flex-col gap-1 border-t border-amber-200 pt-2">
                <p className="text-sm text-amber-800">
                  Soll nur <strong>dieser</strong> Termin entfallen und die zweite Kraft den
                  Einsatz allein übernehmen? Dann entkoppeln statt löschen — der Partner-Termin
                  bleibt vollständig erhalten, samt Dokumentation und Unterschriften.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={decoupleMutation.isPending}
                  onClick={handleDecouple}
                  data-testid="button-decouple-co-visit"
                >
                  Nur diesen Termin entfernen (entkoppeln)
                </Button>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Absage verwirft begonnene Dokumentation — Muster #1883: nicht
          verbieten, aber bewusst bestaetigen lassen. Ohne diesen Dialog waere
          der 409 fuer den Mitarbeiter eine kryptische Blockade. */}
      <AlertDialog
        open={discardConfirm !== null}
        onOpenChange={(offen) => { if (!offen) setDiscardConfirm(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-amber-500`} />
              Begonnene Dokumentation verwerfen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {discardConfirm?.anzahl === 1
                ? "Für diesen Termin wurde bereits dokumentiert. Beim Absagen wird die begonnene Dokumentation verworfen und kann nicht wiederhergestellt werden."
                : `Für ${discardConfirm?.anzahl ?? 0} Termine wurde bereits dokumentiert. Beim Absagen werden die begonnenen Dokumentationen verworfen und können nicht wiederhergestellt werden.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-discard-cancel">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-discard-confirm"
              // `onSelect` + preventDefault: Radix schliesst den Dialog sonst
              // sofort beim Klick — dann waeren `disabled` und der Spinner nie
              // sichtbar, und bei einem Fehler im zweiten Aufruf haette der
              // Nutzer keinen Kontext mehr (Gate-2-Notiz).
              onSelect={(e) => e.preventDefault()}
              onClick={() => {
                if (!discardConfirm) return;
                seriesCancelMutation.mutate({
                  mode: discardConfirm.mode,
                  confirmDiscardDocumentation: true,
                });
              }}
              disabled={seriesCancelMutation.isPending}
            >
              {seriesCancelMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Verwerfen und absagen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showReopenDialog} onOpenChange={setShowReopenDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className={`${iconSize.md} text-primary`} />
              Dokumentation korrigieren?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Die Dokumentation wird zur Korrektur geöffnet. Vorhandene Budget-Buchungen werden vorübergehend zurückgebucht und bei erneuter Dokumentation neu berechnet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => reopenMutation.mutate(appointment.status)}
              disabled={reopenMutation.isPending}
            >
              {reopenMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Zur Korrektur öffnen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AppointmentSeriesDeleteDialog
        open={showSeriesDeleteDialog}
        onOpenChange={setShowSeriesDeleteDialog}
        isCompleted={appointment?.status === "completed"}
        isPending={seriesCancelMutation.isPending}
        onChoose={(mode) => seriesCancelMutation.mutate({ mode })}
        isCoVisit={isCoVisit}
        coVisitPartnerNames={coVisitPartnerNames}
      />
    </Layout>
  );
}
