import { useState, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, Loader2, AlertCircle, Check, UserX } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useAppointment } from "@/features/appointments/hooks/use-appointments";
import { useDocumentNoShow } from "@/features/appointments/hooks/use-appointment-mutations";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { NO_SHOW_REASONS, NO_SHOW_REASON_LABELS, type NoShowReason } from "@shared/schema";
import type { CancellationPolicyType, NoShowCharge } from "@shared/domain/cancellation-policy";
import { formatEuroDE } from "@shared/utils/money";
import { formatTimeHHMM } from "@shared/utils/datetime";

type CustomerPolicy = {
  cancellationPolicyType: CancellationPolicyType;
  cancellationFlatCents: number | null;
  cancellationHourlyRateCents: number | null;
  cancellationKmRateCents: number | null;
};

export default function DocumentAppointmentNoShow() {
  const [, params] = useRoute("/document-appointment/:id/no-show");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const id = params?.id ? parseInt(params.id) : 0;

  const { data: appointment, isLoading } = useAppointment(id);
  const noShowMutation = useDocumentNoShow(id);

  // Cancellation-Policy des Kunden (nur Selbstzahler werden privat berechnet,
  // aber für die Vorschau zeigen wir die Policy in beiden Fällen).
  const { data: customer } = useQuery<CustomerPolicy>({
    queryKey: ["customer-cancellation-policy", appointment?.customerId],
    queryFn: async () => {
      const result = await api.get<CustomerPolicy>(`/customers/${appointment!.customerId}`);
      return unwrapResult(result);
    },
    enabled: !!appointment?.customerId,
  });

  const [reason, setReason] = useState<NoShowReason>("nicht_angetroffen");
  const [reasonText, setReasonText] = useState("");
  const [waitMinutes, setWaitMinutes] = useState<number>(10);
  const [travelKilometers, setTravelKilometers] = useState<number>(0);
  const [notes, setNotes] = useState("");
  const [chargeMode, setChargeMode] = useState<"charge" | "suppress">("charge");
  const [suppressionReason, setSuppressionReason] = useState("");

  // Vorschau wird SERVER-SEITIG berechnet — gleiche Quelle wie die spätere
  // Buchung & Rechnung (verhindert Preview-vs-Booking-Drift, da der Server
  // Fallback-Sätze aus dem Service-Katalog mit einbezieht).
  const { data: previewData } = useQuery<{
    policyType: CancellationPolicyType;
    billingType: string | null;
    chargeable: boolean;
    charge: NoShowCharge;
  }>({
    queryKey: ["noshow-preview", id, travelKilometers, waitMinutes],
    queryFn: async () => {
      const result = await api.get<{
        policyType: CancellationPolicyType;
        billingType: string | null;
        chargeable: boolean;
        charge: NoShowCharge;
      }>(`/appointments/${id}/no-show-preview?travelKilometers=${travelKilometers}&waitMinutes=${waitMinutes}`);
      return unwrapResult(result);
    },
    enabled: !!appointment?.customerId,
  });
  const chargePreview = previewData?.charge ?? null;

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <Card className="border-destructive">
          <CardContent className="pt-6 text-center">
            <AlertCircle className={`${iconSize.xl} mx-auto text-destructive mb-4`} />
            <p className="text-destructive font-medium">Termin nicht gefunden</p>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  const isBusy = noShowMutation.isPending;
  const reasonTextRequired = reason === "sonstiges";
  const suppressionReasonRequired = chargeMode === "suppress";
  const canSubmit =
    !isBusy &&
    !!appointment.customerId &&
    (!reasonTextRequired || reasonText.trim().length > 0) &&
    (!suppressionReasonRequired || suppressionReason.trim().length >= 10);

  const handleSubmit = async () => {
    const actualStart = appointment.actualStart
      ? formatTimeHHMM(appointment.actualStart)
      : appointment.scheduledStart
        ? formatTimeHHMM(appointment.scheduledStart)
        : "";
    if (!actualStart) {
      toast({ title: "Fehler", description: "Keine Startzeit ermittelbar.", variant: "destructive" });
      return;
    }
    try {
      await noShowMutation.mutateAsync({
        performedByEmployeeId: appointment.assignedEmployeeId ?? null,
        actualStart,
        travelOriginType: "home",
        travelFromAppointmentId: null,
        travelKilometers,
        travelMinutes: null,
        noShowReason: reason,
        noShowReasonText: reasonTextRequired ? reasonText.trim() : null,
        noShowWaitMinutes: waitMinutes,
        noShowNotes: notes.trim() || null,
        noShowChargeSuppressed: chargeMode === "suppress",
        noShowChargeSuppressionReason: chargeMode === "suppress" ? suppressionReason.trim() : null,
      });
      setLocation(`/appointment/${id}`);
    } catch {
      // Toast wird vom Mutation-Hook gesetzt
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation(`/document-appointment/${id}`)}
          className="mb-2 -ml-2"
          data-testid="button-back-noshow"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} />
          Zurück zur Dokumentation
        </Button>
        <h1 className={componentStyles.pageTitle} data-testid="text-title-noshow">
          Vergebliche Anfahrt dokumentieren
        </h1>
        <p className="text-muted-foreground text-sm">
          {appointment.customer?.name} • Annahmeverzug nach §615 BGB
        </p>
      </div>

      <div className="space-y-4">
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserX className={`${iconSize.md} text-amber-600`} />
              Was ist passiert?
            </CardTitle>
            <CardDescription>
              Sie werden für diesen Termin voll bezahlt (geplante Dauer + Anfahrt).
              §45b-Budget des Kunden wird nicht belastet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={reason} onValueChange={(v) => setReason(v as NoShowReason)} className="space-y-2">
              {NO_SHOW_REASONS.map((r) => (
                <div
                  key={r}
                  className={`flex items-center space-x-3 p-3 rounded-lg border ${reason === r ? "border-amber-500 bg-amber-50" : "border-border"}`}
                >
                  <RadioGroupItem value={r} id={`noshow-reason-${r}`} data-testid={`radio-noshow-reason-${r}`} />
                  <Label htmlFor={`noshow-reason-${r}`} className="cursor-pointer flex-1 font-medium">
                    {NO_SHOW_REASON_LABELS[r]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
            {reasonTextRequired && (
              <div className="mt-4 space-y-2">
                <Label htmlFor="noshow-reason-text">Bitte kurz beschreiben *</Label>
                <Input
                  id="noshow-reason-text"
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value.slice(0, 255))}
                  maxLength={255}
                  placeholder="z.B. Tür wurde nicht geöffnet, kein Telefon erreichbar"
                  data-testid="input-noshow-reason-text"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Wartezeit & Anfahrt</CardTitle>
            <CardDescription>
              Tragen Sie ein, wie lange Sie vor Ort gewartet haben und wie viele Kilometer Sie gefahren sind.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="noshow-wait">Wartezeit (Minuten)</Label>
              <Input
                id="noshow-wait"
                type="number"
                min="0"
                max="240"
                step="5"
                value={waitMinutes || ""}
                onChange={(e) => setWaitMinutes(Math.max(0, Math.min(240, parseInt(e.target.value) || 0)))}
                placeholder="0"
                className="min-h-[44px] text-base"
                data-testid="input-noshow-wait-minutes"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="noshow-km">Anfahrt-Kilometer</Label>
              <div className="relative">
                <Input
                  id="noshow-km"
                  type="number"
                  min="0"
                  max="500"
                  step="0.1"
                  value={travelKilometers || ""}
                  onChange={(e) => setTravelKilometers(Math.max(0, parseFloat(e.target.value) || 0))}
                  placeholder="0"
                  className="pr-12 min-h-[44px] text-base"
                  data-testid="input-noshow-kilometers"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">km</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="noshow-notes">Notiz (optional)</Label>
              <Textarea
                id="noshow-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 255))}
                maxLength={255}
                placeholder="Interne Notiz für die Akte"
                rows={3}
                data-testid="textarea-noshow-notes"
              />
            </div>
          </CardContent>
        </Card>

        {chargeMode === "charge" && chargePreview && customer && customer.cancellationPolicyType !== "none" && (
          <Card className="bg-muted/40" data-testid="card-noshow-charge-preview">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Privatrechnung (Vorschau)</CardTitle>
              <CardDescription>
                {chargePreview.totalCents > 0
                  ? "Dieser Betrag wird dem Kunden als „Vergebliche Anfahrt“ in Rechnung gestellt."
                  : "Es wird nichts berechnet (Kulanz / keine Sätze hinterlegt)."}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              {chargePreview.travelCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Anfahrt</span>
                  <span data-testid="text-noshow-charge-travel">{formatEuroDE(chargePreview.travelCents)}</span>
                </div>
              )}
              {chargePreview.waitCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Wartezeit</span>
                  <span data-testid="text-noshow-charge-wait">{formatEuroDE(chargePreview.waitCents)}</span>
                </div>
              )}
              {chargePreview.flatCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Pauschale</span>
                  <span data-testid="text-noshow-charge-flat">{formatEuroDE(chargePreview.flatCents)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Summe</span>
                <span data-testid="text-noshow-charge-total">{formatEuroDE(chargePreview.totalCents)}</span>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Privatrechnung</CardTitle>
            <CardDescription>
              Soll dem Kunden eine "Vergebliche Anfahrt" privat in Rechnung gestellt werden?
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup value={chargeMode} onValueChange={(v) => setChargeMode(v as "charge" | "suppress")} className="space-y-2">
              <div className={`flex items-center space-x-3 p-3 rounded-lg border ${chargeMode === "charge" ? "border-amber-500 bg-amber-50" : "border-border"}`}>
                <RadioGroupItem value="charge" id="charge-mode-charge" data-testid="radio-charge-mode-charge" />
                <Label htmlFor="charge-mode-charge" className="cursor-pointer flex-1 font-medium">
                  Ja, gemäß Stornobedingungen berechnen
                </Label>
              </div>
              <div className={`flex items-center space-x-3 p-3 rounded-lg border ${chargeMode === "suppress" ? "border-amber-500 bg-amber-50" : "border-border"}`}>
                <RadioGroupItem value="suppress" id="charge-mode-suppress" data-testid="radio-charge-mode-suppress" />
                <Label htmlFor="charge-mode-suppress" className="cursor-pointer flex-1 font-medium">
                  Nein, auf Kulanz verzichten
                </Label>
              </div>
            </RadioGroup>
            {suppressionReasonRequired && (
              <div className="space-y-2">
                <Label htmlFor="suppression-reason">Begründung für Kulanz * (mind. 10 Zeichen, wird im Audit protokolliert)</Label>
                <Textarea
                  id="suppression-reason"
                  value={suppressionReason}
                  onChange={(e) => setSuppressionReason(e.target.value.slice(0, 500))}
                  maxLength={500}
                  placeholder="z.B. Stammkundin, erste Versäumnis seit Jahren"
                  rows={2}
                  data-testid="textarea-suppression-reason"
                />
                <p className="text-xs text-muted-foreground">{suppressionReason.length}/500</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Button
          className={`w-full ${componentStyles.btnPrimary}`}
          size="lg"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid="button-submit-noshow"
        >
          {isBusy ? (
            <>
              <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              Wird gespeichert...
            </>
          ) : (
            <>
              <Check className={`${iconSize.sm} mr-2`} />
              Vergebliche Anfahrt speichern
            </>
          )}
        </Button>
      </div>
    </Layout>
  );
}
