import { useRoute } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ChevronLeft, Loader2, AlertTriangle, Users, Repeat } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import {
  useEditAppointment,
  EditAppointmentProspectFields,
  EditAppointmentDateTimeFields,
  EditAppointmentServicesSection,
  EditAppointmentDurationSection,
  EditAppointmentSeriesDialog,
} from "@/features/appointments";

export default function EditAppointment() {
  const [, params] = useRoute("/edit-appointment/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const f = useEditAppointment(id);
  const { appointment, appointmentLoading, setLocation } = f;

  if (appointmentLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <div className="text-center py-12">Termin nicht gefunden</div>
      </Layout>
    );
  }

  if (appointment.status === "completed" && !appointment.seriesId) {
    return (
      <Layout>
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation(appointment?.date ? `/?date=${appointment.date}` : "/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <div className="text-center py-12 space-y-4">
          <AlertTriangle className={`${iconSize.xl} text-amber-500 mx-auto`} />
          <h2 className="text-xl font-bold">Bearbeitung nicht möglich</h2>
          <p className="text-muted-foreground">Abgeschlossene Termine können nicht bearbeitet werden.</p>
        </div>
      </Layout>
    );
  }

  const { isKundentermin, isErstberatung } = f;

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation(appointment?.date ? `/?date=${appointment.date}` : "/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <h1 className={componentStyles.pageTitle}>
          {isErstberatung ? "Erstberatung bearbeiten" : "Termin bearbeiten"}
        </h1>
        {!isErstberatung && appointment.customer && (
          <p className="text-muted-foreground mt-1">{appointment.customer.name}</p>
        )}
      </div>

      {appointment.seriesId && (
        <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg" data-testid="banner-series-edit-info">
          <div className="flex items-center gap-2">
            <Repeat className={`${iconSize.sm} text-primary`} />
            <span className="text-sm font-medium text-primary">
              Teil einer Serie
            </span>
            <span className="text-xs text-muted-foreground">
              — Beim Speichern wählen Sie, ob nur dieser oder weitere Termine geändert werden
            </span>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {isKundentermin ? "Kundentermin" : "Erstberatung"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isKundentermin && f.canChangeKtAssignment && (
            <div className="space-y-2">
              <Label>
                <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
              </Label>
              <SearchableSelect
                options={f.ktEmployeeOptions}
                value={f.ktAssignedEmployeeId}
                onValueChange={f.setKtAssignedEmployeeId}
                placeholder="Mitarbeiter auswählen..."
                searchPlaceholder="Mitarbeiter suchen..."
                emptyText="Kein Mitarbeiter gefunden."
                className={f.errors.ktAssignedEmployeeId ? "border-destructive" : ""}
                data-testid="select-kt-employee"
              />
              {f.errors.ktAssignedEmployeeId && <p className="text-destructive text-sm">{f.errors.ktAssignedEmployeeId}</p>}
            </div>
          )}

          {isErstberatung && (
            <EditAppointmentProspectFields
              ebVorname={f.ebVorname}
              setEbVorname={f.setEbVorname}
              ebNachname={f.ebNachname}
              setEbNachname={f.setEbNachname}
              ebTelefon={f.ebTelefon}
              setEbTelefon={f.setEbTelefon}
              ebEmail={f.ebEmail}
              setEbEmail={f.setEbEmail}
              ebStrasse={f.ebStrasse}
              setEbStrasse={f.setEbStrasse}
              ebNr={f.ebNr}
              setEbNr={f.setEbNr}
              ebPlz={f.ebPlz}
              setEbPlz={f.setEbPlz}
              ebStadt={f.ebStadt}
              setEbStadt={f.setEbStadt}
              ebPflegegrad={f.ebPflegegrad}
              setEbPflegegrad={f.setEbPflegegrad}
              ebAssignedEmployeeId={f.ebAssignedEmployeeId}
              setEbAssignedEmployeeId={f.setEbAssignedEmployeeId}
              ebEmployeeOptions={f.ebEmployeeOptions}
              errors={f.errors}
              canEditProspectFields={f.canEditProspectFields}
              canChangeKtAssignment={f.canChangeKtAssignment}
              ebFullyLocked={f.ebFullyLocked}
              ebLockHint={f.ebLockHint}
            />
          )}

          <EditAppointmentDateTimeFields
            date={f.date}
            setDate={f.setDate}
            time={f.time}
            setTime={f.setTime}
            isErstberatung={isErstberatung}
            isAdmin={f.isAdmin}
            ebFullyLocked={f.ebFullyLocked}
            ebAssignedEmployeeId={f.ebAssignedEmployeeId}
            setEbAssignedEmployeeId={f.setEbAssignedEmployeeId}
          />

          {isKundentermin ? (
            <EditAppointmentServicesSection
              services={f.services}
              setServices={f.setServices}
              errors={f.errors}
              fahrtdienst={f.fahrtdienst}
              setFahrtdienst={f.setFahrtdienst}
              effectiveCustomerLat={f.effectiveCustomerLat}
              effectiveCustomerLng={f.effectiveCustomerLng}
              handlePickupTimeCalculated={f.handlePickupTimeCalculated}
              time={f.time}
              setTime={f.setTime}
              isGeocodingCustomer={f.isGeocodingCustomer}
              geocodingError={f.geocodingError}
              summary={f.summary}
              costEstimate={f.costEstimate}
              billingType={appointment?.customer?.billingType}
            />
          ) : (
            <EditAppointmentDurationSection
              isErstberatung={isErstberatung}
              duration={f.duration}
              setDuration={f.setDuration}
              time={f.time}
              setEndTime={f.setEndTime}
              ebFullyLocked={f.ebFullyLocked}
              summary={f.summary}
              errors={f.errors}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notizen (optional, max. 255 Zeichen)</Label>
            <Textarea
              id="notes"
              placeholder={isErstberatung ? "Besondere Hinweise zur Erstberatung..." : "Besondere Hinweise..."}
              value={f.notes}
              onChange={(e) => f.setNotes(e.target.value.slice(0, 255))}
              maxLength={255}
              disabled={f.ebFullyLocked}
              data-testid="textarea-notes"
            />
            <p className="text-xs text-muted-foreground">{f.notes.length}/255</p>
          </div>

          <Button
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={f.handleSubmit}
            disabled={f.isPending || !f.hasChanges || f.ebFullyLocked}
            title={
              f.ebFullyLocked
                ? "Dieser Termin ist abgeschlossen und kann nicht mehr bearbeitet werden."
                : !f.hasChanges && !f.isPending
                  ? "Keine Änderungen zu speichern"
                  : undefined
            }
            data-testid="button-save"
          >
            {f.isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
            Änderungen speichern
          </Button>
        </CardContent>
      </Card>

      <EditAppointmentSeriesDialog
        open={f.showSeriesEditDialog}
        onOpenChange={f.setShowSeriesEditDialog}
        appointmentStatus={appointment?.status}
        isPending={f.seriesUpdatePending}
        onSelect={f.handleSeriesUpdate}
      />
    </Layout>
  );
}
