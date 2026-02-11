import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { ChevronLeft, Loader2, Calendar, Clock, User, Home, Plus, Users, AlertTriangle } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useNewAppointmentForm, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import { useLocation } from "wouter";

export default function NewAppointment() {
  const [, setLocation] = useLocation();
  const form = useNewAppointmentForm();

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <h1 className="text-2xl font-bold">Neuer Termin</h1>
      </div>

      <Tabs value={form.activeTab} onValueChange={form.setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 mb-6">
          <TabsTrigger value="kundentermin" data-testid="tab-kundentermin">
            <User className={`${iconSize.sm} mr-2`} /> Kundentermin
          </TabsTrigger>
          <TabsTrigger value="erstberatung" data-testid="tab-erstberatung">
            <Plus className={`${iconSize.sm} mr-2`} /> Erstberatung
          </TabsTrigger>
        </TabsList>

        {/* Kundentermin Form */}
        <TabsContent value="kundentermin">
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

              {/* Employee Assignment (Admin only - required) */}
              {form.isAdmin && (
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
                  <p className="text-xs text-muted-foreground">
                    Der Mitarbeiter muss dem Kunden zugeordnet sein (Haupt- oder Vertretungsmitarbeiter)
                  </p>
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
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit
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
              />

              {form.ktSummary.hasServices && (
                <AppointmentSummary
                  startTime={form.ktSummary.startTime}
                  endTime={form.ktSummary.endTime}
                  services={form.ktSummary.services}
                  totalFormatted={form.ktSummary.totalFormatted}
                />
              )}

              {form.costEstimate && !form.costEstimate.noPricing && form.costEstimate.totalCents > 0 && (
                <div className="rounded-lg border bg-blue-50 border-blue-200 p-3 text-sm" data-testid="budget-cost-estimate">
                  <p className="font-medium text-blue-800">
                    Geschätzte Kosten: {(form.costEstimate.totalCents / 100).toFixed(2)} €
                  </p>
                  {form.costEstimate.availableCents !== undefined && (
                    <p className="text-blue-600 text-xs mt-1">
                      Verfügbares Budget: {(form.costEstimate.availableCents / 100).toFixed(2)} €
                    </p>
                  )}
                </div>
              )}

              {form.costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-red-50 border-red-300 p-3 text-sm flex items-start gap-2" data-testid="budget-hard-block">
                  <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <p className="text-red-800 font-medium">Budget reicht nicht aus. Termin kann nicht erstellt werden.</p>
                </div>
              )}

              {form.costEstimate?.warning && !form.costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-amber-50 border-amber-200 p-3 text-sm flex items-start gap-2" data-testid="budget-warning">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-amber-800">{form.costEstimate.warning}</p>
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
                Kundentermin erstellen
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Erstberatung Form */}
        <TabsContent value="erstberatung">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Erstberatung für neuen Kunden</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Personal Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="eb-vorname">Vorname *</Label>
                  <Input
                    id="eb-vorname"
                    value={form.ebVorname}
                    onChange={(e) => form.setEbVorname(e.target.value)}
                    placeholder="Max"
                    data-testid="input-eb-vorname"
                  />
                  {form.errors.ebVorname && <p className="text-destructive text-sm">{form.errors.ebVorname}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eb-nachname">Nachname *</Label>
                  <Input
                    id="eb-nachname"
                    value={form.ebNachname}
                    onChange={(e) => form.setEbNachname(e.target.value)}
                    placeholder="Mustermann"
                    data-testid="input-eb-nachname"
                  />
                  {form.errors.ebNachname && <p className="text-destructive text-sm">{form.errors.ebNachname}</p>}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="eb-telefon">Telefon *</Label>
                <Input
                  id="eb-telefon"
                  type="tel"
                  value={form.ebTelefon}
                  onChange={(e) => form.setEbTelefon(form.formatPhoneAsYouType(e.target.value))}
                  placeholder="0171 1234567"
                  data-testid="input-eb-telefon"
                />
                <p className="text-xs text-muted-foreground">Mobil (0171...) oder Festnetz (030...)</p>
                {form.errors.ebTelefon && <p className="text-destructive text-sm">{form.errors.ebTelefon}</p>}
              </div>

              {/* Address */}
              <div className="space-y-4">
                <Label className="flex items-center gap-2">
                  <Home className={iconSize.sm} /> Adresse
                </Label>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="eb-strasse">Straße *</Label>
                    <Input
                      id="eb-strasse"
                      value={form.ebStrasse}
                      onChange={(e) => form.setEbStrasse(e.target.value)}
                      placeholder="Musterstraße"
                      data-testid="input-eb-strasse"
                    />
                    {form.errors.ebStrasse && <p className="text-destructive text-sm">{form.errors.ebStrasse}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="eb-nr">Nr. *</Label>
                    <Input
                      id="eb-nr"
                      value={form.ebNr}
                      onChange={(e) => form.setEbNr(e.target.value)}
                      placeholder="42"
                      data-testid="input-eb-nr"
                    />
                    {form.errors.ebNr && <p className="text-destructive text-sm">{form.errors.ebNr}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="eb-plz">PLZ *</Label>
                    <Input
                      id="eb-plz"
                      value={form.ebPlz}
                      onChange={(e) => form.setEbPlz(e.target.value)}
                      placeholder="10969"
                      maxLength={5}
                      data-testid="input-eb-plz"
                    />
                    {form.errors.ebPlz && <p className="text-destructive text-sm">{form.errors.ebPlz}</p>}
                  </div>
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="eb-stadt">Stadt *</Label>
                    <Input
                      id="eb-stadt"
                      value={form.ebStadt}
                      onChange={(e) => form.setEbStadt(e.target.value)}
                      placeholder="Berlin"
                      data-testid="input-eb-stadt"
                    />
                    {form.errors.ebStadt && <p className="text-destructive text-sm">{form.errors.ebStadt}</p>}
                  </div>
                </div>
              </div>

              {/* Pflegegrad */}
              <div className="space-y-2">
                <Label>Pflegegrad *</Label>
                <Select value={form.ebPflegegrad} onValueChange={form.setEbPflegegrad}>
                  <SelectTrigger data-testid="select-pflegegrad">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p.toString()}>
                        Pflegegrad {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Employee Assignment (Admin only - required) */}
              {form.isAdmin && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <SearchableSelect
                    options={form.employeeOptions}
                    value={form.ebAssignedEmployeeId}
                    onValueChange={form.setEbAssignedEmployeeId}
                    placeholder="Mitarbeiter auswählen..."
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    className={form.errors.ebAssignedEmployeeId ? "border-destructive" : ""}
                    data-testid="select-eb-employee"
                  />
                  {form.errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{form.errors.ebAssignedEmployeeId}</p>}
                  <p className="text-xs text-muted-foreground">
                    Der ausgewählte Mitarbeiter wird automatisch Hauptmitarbeiter für diesen neuen Kunden
                  </p>
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum *
                  </Label>
                  <DatePicker
                    value={form.ebDate || null}
                    onChange={(val) => form.setEbDate(val || "")}
                    disableWeekends
                    data-testid="input-eb-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eb-start">
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit *
                  </Label>
                  <Input
                    id="eb-start"
                    type="time"
                    value={form.ebStartTime}
                    onChange={(e) => form.setEbStartTime(e.target.value)}
                    className="text-base"
                    data-testid="input-eb-start"
                  />
                </div>
              </div>

              {/* Service (Erstberatung) */}
              <div className="space-y-4">
                <Label>Service</Label>
                <div className="flex items-center justify-between p-4 rounded-lg border bg-purple-50 border-purple-200">
                  <div className="flex-1">
                    <span className="font-medium text-purple-800">Erstberatung</span>
                  </div>
                  <Select
                    value={form.ebErstberatungDauer.toString()}
                    onValueChange={(v) => form.setEbErstberatungDauer(parseInt(v))}
                  >
                    <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-erstberatung-dauer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((d) => (
                        <SelectItem key={d} value={d.toString()}>
                          {formatDuration(d)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Summary */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3" data-testid="eb-summary-panel">
                <div className="flex items-center gap-2 text-purple-700 font-semibold">
                  <Clock className={iconSize.sm} />
                  <span>Terminübersicht</span>
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-purple-600">Von</span>
                    <p className="font-medium text-lg text-purple-800">{form.ebSummary.startTime} Uhr</p>
                  </div>
                  <div>
                    <span className="text-purple-600">Bis</span>
                    <p className="font-medium text-lg text-purple-800">{form.ebSummary.endTime} Uhr</p>
                  </div>
                </div>

                <div className="border-t border-purple-200 pt-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-purple-700">Erstberatung</span>
                    <span className="font-medium text-purple-800">{form.ebSummary.totalFormatted}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="eb-notes">Notizen (optional, max. 255 Zeichen)</Label>
                <Textarea
                  id="eb-notes"
                  placeholder="Besondere Hinweise zur Erstberatung..."
                  value={form.ebNotes}
                  onChange={(e) => form.setEbNotes(e.target.value.slice(0, 255))}
                  maxLength={255}
                  data-testid="textarea-eb-notes"
                />
                <p className="text-xs text-muted-foreground">{form.ebNotes.length}/255</p>
              </div>

              <Button
                className={`w-full ${componentStyles.btnPrimary}`}
                size="lg"
                onClick={form.handleErstberatungSubmit}
                disabled={form.isPending}
                data-testid="button-create-erstberatung"
              >
                {form.isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                Erstberatung erstellen
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
