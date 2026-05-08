import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, Calendar, Clock, Users, Repeat } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { WEEKDAYS } from "@shared/schema/appointments";
import { WEEKDAY_LABELS, formatWeekdays } from "@/features/appointments/hooks/use-appointment-series";
import {
  ServiceSelector,
  AppointmentSummary,
  FahrtdienstDetails,
  CostEstimatePreview,
} from "@/features/appointments";
import type { useNewAppointmentForm } from "@/features/appointments/hooks/use-new-appointment-form";

type AppointmentForm = ReturnType<typeof useNewAppointmentForm>;

export function NewAppointmentKundenterminTab({ form, onBack }: { form: AppointmentForm; onBack: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Termin für bestehenden Kunden</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
              {/* Customer Selection */}
              <div className="space-y-2">
                <Label>Kunde auswählen</Label>
                <SearchableSelect
                  options={form.customerOptions}
                  value={form.ktCustomerId}
                  onValueChange={form.setKtCustomerId}
                  placeholder="Kunde auswählen..."
                  searchPlaceholder="Kunde suchen..."
                  emptyText="Kein Kunde gefunden."
                  isLoading={form.customersLoading}
                  data-testid="select-customer"
                />
                {form.errors.ktCustomerId && <p className="text-destructive text-sm">{form.errors.ktCustomerId}</p>}
              </div>

              {/* Mitarbeiter-Zuweisung (Admin und Teamleitung — Pflichtfeld) */}
              {form.canChangeAssignment && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <SearchableSelect
                    options={form.employeeOptions}
                    value={form.ktAssignedEmployeeId}
                    onValueChange={form.setKtAssignedEmployeeId}
                    placeholder="Mitarbeiter auswählen..."
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    className={form.errors.ktAssignedEmployeeId ? "border-destructive" : ""}
                    data-testid="select-kt-employee"
                  />
                  {form.errors.ktAssignedEmployeeId && <p className="text-destructive text-sm">{form.errors.ktAssignedEmployeeId}</p>}
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum
                  </Label>
                  <DatePicker
                    value={form.ktDate || null}
                    onChange={(val) => form.setKtDate(val || "")}
                    disableWeekends
                    data-testid="input-kt-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kt-time">
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit / Abholzeit
                  </Label>
                  <Input
                    id="kt-time"
                    type="time"
                    value={form.ktTime}
                    onChange={(e) => form.setKtTime(e.target.value)}
                    className="text-base"
                    data-testid="input-kt-time"
                  />
                </div>
              </div>

              <ServiceSelector
                services={form.ktServices}
                onChange={form.setKtServices}
                error={form.errors.ktServices}
                renderAlltagsbegleitungDetails={() => (
                  <FahrtdienstDetails
                    fahrtdienst={form.fahrtdienst}
                    onChange={form.setFahrtdienst}
                    customerLat={form.effectiveCustomerLat}
                    customerLng={form.effectiveCustomerLng}
                    onPickupTimeCalculated={form.handlePickupTimeCalculated}
                    currentStartTime={form.ktTime}
                    onApplyPickupTime={form.setKtTime}
                    errors={form.errors}
                    isGeocodingCustomer={form.isGeocodingCustomer}
                    geocodingError={form.geocodingError}
                  />
                )}
              />

              {form.ktSummary.hasServices && (
                <AppointmentSummary
                  startTime={form.ktSummary.startTime}
                  endTime={form.ktSummary.endTime}
                  services={form.ktSummary.services}
                  totalFormatted={form.ktSummary.totalFormatted}
                />
              )}

              <CostEstimatePreview
                costEstimate={form.costEstimate}
                billingType={form.selectedCustomerBillingType}
              />

              {/* Series Toggle */}
              {!form.copyFromId && (
                <div className="rounded-lg border p-4 space-y-4" data-testid="panel-series">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Repeat className={`${iconSize.sm} text-primary`} />
                      <Label htmlFor="series-toggle" className="font-medium cursor-pointer">
                        Serientermin
                      </Label>
                    </div>
                    <Switch
                      id="series-toggle"
                      checked={form.seriesEnabled}
                      onCheckedChange={form.setSeriesEnabled}
                      data-testid="switch-series-toggle"
                    />
                  </div>

                  {form.seriesEnabled && (
                    <div className="space-y-4 pt-2 border-t">
                      <div className="space-y-2">
                        <Label>Wochentage</Label>
                        <div className="flex gap-2">
                          {WEEKDAYS.map((day) => {
                            const isSelected = form.seriesWeekdays.includes(day);
                            return (
                              <button
                                key={day}
                                type="button"
                                onClick={() => {
                                  form.setSeriesWeekdays(
                                    isSelected
                                      ? form.seriesWeekdays.filter(d => d !== day)
                                      : [...form.seriesWeekdays, day]
                                  );
                                }}
                                className={`flex-1 min-h-[48px] rounded-lg text-sm font-semibold transition-colors ${
                                  isSelected
                                    ? "bg-primary text-primary-foreground shadow-sm"
                                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                                }`}
                                data-testid={`button-weekday-${day}`}
                              >
                                {WEEKDAY_LABELS[day]}
                              </button>
                            );
                          })}
                        </div>
                        {form.errors.seriesWeekdays && <p className="text-destructive text-sm">{form.errors.seriesWeekdays}</p>}
                      </div>

                      <div className="space-y-2">
                        <Label>Häufigkeit</Label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => form.setSeriesFrequency("weekly")}
                            className={`min-h-[48px] rounded-lg text-sm font-medium transition-colors ${
                              form.seriesFrequency === "weekly"
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                            data-testid="button-freq-weekly"
                          >
                            Wöchentlich
                          </button>
                          <button
                            type="button"
                            onClick={() => form.setSeriesFrequency("biweekly")}
                            className={`min-h-[48px] rounded-lg text-sm font-medium transition-colors ${
                              form.seriesFrequency === "biweekly"
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                            data-testid="button-freq-biweekly"
                          >
                            Alle 2 Wochen
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>
                          <Calendar className={`${iconSize.sm} inline mr-1`} /> Enddatum
                        </Label>
                        <DatePicker
                          value={form.seriesEndDate || null}
                          onChange={(val) => form.setSeriesEndDate(val || "")}
                          data-testid="input-series-end-date"
                        />
                        <p className="text-xs text-muted-foreground">Max. 12 Monate in die Zukunft</p>
                        {form.errors.seriesEndDate && <p className="text-destructive text-sm">{form.errors.seriesEndDate}</p>}
                      </div>

                      {form.seriesPreview && (
                        <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 space-y-3" data-testid="panel-series-preview">
                          <div className="flex items-center gap-2 text-primary font-semibold text-sm">
                            <Repeat className={iconSize.sm} />
                            <span>Vorschau</span>
                          </div>
                          <p className="text-sm">
                            <strong>{form.seriesPreview.count} Termine</strong> werden erstellt
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatWeekdays(form.seriesPreview.weekdays)}, {form.seriesPreview.startTime} Uhr,{" "}
                            {form.seriesPreview.frequency === "biweekly" ? "alle 2 Wochen" : "wöchentlich"},{" "}
                            bis {new Date(form.seriesPreview.endDate + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
                          </p>
                          {form.seriesPreview.dates.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground">Termine:</p>
                              <div className="max-h-40 overflow-y-auto space-y-0.5 text-xs text-muted-foreground">
                                {form.seriesPreview.dates.map((d, i) => (
                                  <div key={d} className="flex items-center gap-2 py-0.5" data-testid={`preview-date-${i}`}>
                                    <span className="w-5 text-right text-muted-foreground/60">{i + 1}.</span>
                                    <span>{new Date(d + "T00:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="kt-notes">Notizen (optional, max. 255 Zeichen)</Label>
                <Textarea
                  id="kt-notes"
                  placeholder="Besondere Hinweise..."
                  value={form.ktNotes}
                  onChange={(e) => form.setKtNotes(e.target.value.slice(0, 255))}
                  maxLength={255}
                  data-testid="textarea-kt-notes"
                />
                <p className="text-xs text-muted-foreground">{form.ktNotes.length}/255</p>
              </div>

              <Button
                className={`w-full ${componentStyles.btnPrimary}`}
                size="lg"
                onClick={form.handleKundenterminSubmit}
                disabled={form.isPending || form.costEstimate?.isHardBlock === true}
                data-testid="button-create-kundentermin"
              >
                {form.isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                {form.seriesEnabled ? "Terminserie erstellen" : "Kundentermin erstellen"}
              </Button>
              <Button
                variant="outline"
                className="w-full mt-2"
                size="lg"
                onClick={onBack}
                disabled={form.isPending}
                data-testid="button-cancel-kundentermin"
              >
                Abbrechen
              </Button>
      </CardContent>
    </Card>
  );
}
