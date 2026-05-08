import { useMemo, useCallback } from "react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, Loader2, Clock, User, Plus, Copy } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useNewAppointmentForm } from "@/features/appointments";
import { NewAppointmentKundenterminTab } from "@/features/appointments/components/new-appointment-kundentermin-tab";
import { NewAppointmentErstberatungTab } from "@/features/appointments/components/new-appointment-erstberatung-tab";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useAdminEmployees } from "@/features/appointments/hooks/use-active-employees";
import {
  useTimeEntryForm,
  useTimeEntryConflict,
  useCreateTimeEntry,
  TimeEntryFormContent,
} from "@/features/time-tracking";
import type { TimeEntryType } from "@/lib/api/types";
import { todayISO } from "@shared/utils/datetime";

const VALID_ENTRY_TYPES: TimeEntryType[] = [
  "urlaub",
  "krankheit",
  "pause",
  "bueroarbeit",
  "vertrieb",
  "sonstiges",
  "verfuegbar",
  "blocker",
];

export default function NewAppointment() {
  const [, setLocation] = useLocation();
  const form = useNewAppointmentForm();
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.isAdmin ?? false;

  const urlParams = useMemo(
    () => (typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams()),
    [],
  );
  const fromParam = urlParams.get("from");
  const requestedDate = urlParams.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(urlParams.get("date")!) ? urlParams.get("date")! : todayISO();
  const requestedEntryTypeRaw = urlParams.get("entryType");
  const requestedEntryType: TimeEntryType | undefined = requestedEntryTypeRaw && (VALID_ENTRY_TYPES as string[]).includes(requestedEntryTypeRaw)
    ? (requestedEntryTypeRaw as TimeEntryType)
    : undefined;

  const handleBackNavigation = useCallback(() => {
    if (fromParam === "my-times") {
      setLocation("/my-times");
    } else {
      setLocation(`/?date=${requestedDate}`);
    }
  }, [fromParam, requestedDate, setLocation]);

  const { data: adminEmployees = [] } = useAdminEmployees({ enabled: isAdmin });
  const entryEmployeeOptions = useMemo(
    () =>
      adminEmployees
        .filter((e) => e.isActive)
        .map((e) => ({ value: e.id.toString(), label: e.displayName }))
        .sort((a, b) => a.label.localeCompare(b.label, "de")),
    [adminEmployees],
  );

  const entryForm = useTimeEntryForm({
    entryDate: requestedDate,
    entryType: requestedEntryType ?? "pause",
  });
  const entryValidation = useTimeEntryConflict(
    form.activeTab === "eintrag"
      ? {
          entryDate: entryForm.formState.entryDate,
          entryType: entryForm.formState.entryType,
          startTime: entryForm.formState.startTime,
          endTime: entryForm.formState.endTime,
          isFullDay: entryForm.formState.isFullDay,
          targetUserId: entryForm.formState.targetUserId ?? undefined,
        }
      : null,
    form.activeTab === "eintrag",
  );
  const createEntryMutation = useCreateTimeEntry();

  const handleEntrySubmit = useCallback(() => {
    const req = entryForm.toCreateRequest();
    if ((req.entryType === "urlaub" || req.entryType === "krankheit") && req.endDate) {
      if (req.endDate < req.entryDate) {
        toast({ title: "Fehler", description: "Enddatum muss nach Startdatum liegen", variant: "destructive" });
        return;
      }
    }
    createEntryMutation.mutate(req, {
      onSuccess: (data: unknown) => {
        const result = data as { _multiDay?: { count: number; message: string } };
        if (result?._multiDay && result._multiDay.count > 1) {
          toast({ title: `${result._multiDay.count} Einträge erstellt` });
        } else {
          toast({ title: "Eintrag erstellt" });
        }
        handleBackNavigation();
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  }, [entryForm, createEntryMutation, toast, handleBackNavigation]);

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={handleBackNavigation}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <h1 className={componentStyles.pageTitle}>Neuer Eintrag</h1>
        {form.copyFromId && form.copyFromCustomerName && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800" data-testid="banner-copy-info">
            <Copy className={iconSize.sm} />
            <span>Kopie von Termin bei <strong>{form.copyFromCustomerName}</strong></span>
          </div>
        )}
      </div>

      <Tabs value={form.activeTab} onValueChange={form.setActiveTab} className="w-full">
        <TabsList className={`grid w-full mb-6 ${form.canErstberatung ? "grid-cols-3" : "grid-cols-2"}`}>
          <TabsTrigger value="kundentermin" data-testid="tab-kundentermin">
            <User className={`${iconSize.sm} mr-2`} /> Kundentermin
          </TabsTrigger>
          {form.canErstberatung && (
            <TabsTrigger value="erstberatung" data-testid="tab-erstberatung">
              <Plus className={`${iconSize.sm} mr-2`} /> Erstberatung
            </TabsTrigger>
          )}
          <TabsTrigger value="eintrag" data-testid="tab-eintrag">
            <Clock className={`${iconSize.sm} mr-2`} /> Eintrag
          </TabsTrigger>
        </TabsList>

        <TabsContent value="kundentermin">
          <NewAppointmentKundenterminTab form={form} onBack={handleBackNavigation} />
        </TabsContent>

        {form.canErstberatung && (
          <TabsContent value="erstberatung">
            <NewAppointmentErstberatungTab form={form} onBack={handleBackNavigation} />
          </TabsContent>
        )}

        <TabsContent value="eintrag">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Neuer Zeiteintrag</CardTitle>
            </CardHeader>
            <CardContent>
              <TimeEntryFormContent
                formState={entryForm.formState}
                onFieldChange={entryForm.updateField}
                validation={entryValidation}
                onSubmit={handleEntrySubmit}
                onCancel={handleBackNavigation}
                isSubmitting={createEntryMutation.isPending}
                isFullDayType={entryForm.isFullDayType}
                supportsDateRange={entryForm.supportsDateRange}
                submitLabel="Eintrag erstellen"
                testIdPrefix="entry"
                isAdmin={isAdmin}
                employeeOptions={entryEmployeeOptions}
                hideFooter
              />
              <Button
                className={`w-full mt-4 ${componentStyles.btnPrimary}`}
                size="lg"
                onClick={handleEntrySubmit}
                disabled={createEntryMutation.isPending || entryValidation.hasError}
                data-testid="button-create-zeiteintrag"
              >
                {createEntryMutation.isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                Eintrag erstellen
              </Button>
              <Button
                variant="outline"
                className="w-full mt-2"
                size="lg"
                onClick={handleBackNavigation}
                disabled={createEntryMutation.isPending}
                data-testid="button-cancel-zeiteintrag"
              >
                Abbrechen
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
