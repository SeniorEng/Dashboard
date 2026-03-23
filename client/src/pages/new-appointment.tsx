import { useState } from "react";
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
import { ChevronLeft, Loader2, Calendar, Clock, User, Plus, Users, AlertTriangle, XCircle, Copy, UserCheck, Phone, UserPlus, Pencil, Check, X, Home, Mail } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useNewAppointmentForm, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { EmployeeAvailability } from "@/features/appointments/components/employee-availability";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import { useLocation } from "wouter";
import { useUpdateProspect } from "@/features/prospects";

export default function NewAppointment() {
  const [, setLocation] = useLocation();
  const form = useNewAppointmentForm();
  const updateProspectMutation = useUpdateProspect();

  const [editingEbContact, setEditingEbContact] = useState(false);
  const [ebEditTelefon, setEbEditTelefon] = useState("");
  const [ebEditEmail, setEbEditEmail] = useState("");
  const [ebEditStrasse, setEbEditStrasse] = useState("");
  const [ebEditNr, setEbEditNr] = useState("");
  const [ebEditPlz, setEbEditPlz] = useState("");
  const [ebEditStadt, setEbEditStadt] = useState("");

  const startEditingEbContact = () => {
    if (!form.prospectData) return;
    setEbEditTelefon(form.prospectData.telefon || "");
    setEbEditEmail(form.prospectData.email || "");
    setEbEditStrasse(form.prospectData.strasse || "");
    setEbEditNr(form.prospectData.nr || "");
    setEbEditPlz(form.prospectData.plz || "");
    setEbEditStadt(form.prospectData.stadt || "");
    setEditingEbContact(true);
  };

  const handleSaveEbContact = () => {
    if (!form.prospectData) return;
    updateProspectMutation.mutate({
      id: form.prospectData.id,
      data: {
        telefon: ebEditTelefon.trim() || null,
        email: ebEditEmail.trim() || null,
        strasse: ebEditStrasse.trim() || null,
        nr: ebEditNr.trim() || null,
        plz: ebEditPlz.trim() || null,
        stadt: ebEditStadt.trim() || null,
      },
    }, {
      onSuccess: () => setEditingEbContact(false),
    });
  };

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
        <h1 className={componentStyles.pageTitle}>Neuer Termin</h1>
        {form.copyFromId && form.copyFromCustomerName && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800" data-testid="banner-copy-info">
            <Copy className={iconSize.sm} />
            <span>Kopie von Termin bei <strong>{form.copyFromCustomerName}</strong></span>
          </div>
        )}
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
                    Geschätzte Kosten: {(form.costEstimate.totalCents / 100).toFixed(2).replace(".", ",")} €
                  </p>
                  {form.costEstimate.availableCents !== undefined && (
                    <p className="text-blue-600 text-xs mt-1">
                      Verfügbares Budget: {(form.costEstimate.availableCents / 100).toFixed(2).replace(".", ",")} €
                    </p>
                  )}
                </div>
              )}

              {form.costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-red-50 border-red-300 p-4 text-sm flex items-start gap-3" data-testid="budget-hard-block">
                  <XCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-red-800 font-semibold">Termin kann nicht erstellt werden</p>
                    <p className="text-red-700 mt-1">{form.costEstimate.warning || "Das Budget ist aufgebraucht und der Kunde akzeptiert keine private Zuzahlung."}</p>
                  </div>
                </div>
              )}

              {form.costEstimate?.warning && !form.costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-warning">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-amber-800 font-semibold">Budget-Hinweis</p>
                    <p className="text-amber-700 mt-1">{form.costEstimate.warning}</p>
                  </div>
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
              <CardTitle className="text-lg">Erstberatung für Interessenten</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {!form.fromProspectId ? (
                <div className="space-y-4">
                  {form.isAdmin ? (
                    <>
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="panel-inline-prospect">
                        <div className="flex items-center gap-2 text-blue-800 font-medium mb-3">
                          <UserPlus className={iconSize.sm} />
                          <span>Neuen Interessenten anlegen</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="inline-vorname">Vorname *</Label>
                            <Input
                              id="inline-vorname"
                              placeholder="Vorname"
                              value={form.inlineProspectVorname}
                              onChange={(e) => form.setInlineProspectVorname(e.target.value)}
                              className={form.errors.inlineVorname ? "border-destructive" : ""}
                              data-testid="input-inline-vorname"
                            />
                            {form.errors.inlineVorname && <p className="text-destructive text-xs">{form.errors.inlineVorname}</p>}
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="inline-nachname">Nachname *</Label>
                            <Input
                              id="inline-nachname"
                              placeholder="Nachname"
                              value={form.inlineProspectNachname}
                              onChange={(e) => form.setInlineProspectNachname(e.target.value)}
                              className={form.errors.inlineNachname ? "border-destructive" : ""}
                              data-testid="input-inline-nachname"
                            />
                            {form.errors.inlineNachname && <p className="text-destructive text-xs">{form.errors.inlineNachname}</p>}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                          <div className="space-y-1">
                            <Label htmlFor="inline-telefon">
                              <Phone className={`${iconSize.sm} inline mr-1`} /> Telefon *
                            </Label>
                            <Input
                              id="inline-telefon"
                              placeholder="z.B. 0151 12345678"
                              value={form.inlineProspectTelefon}
                              onChange={(e) => form.setInlineProspectTelefon(e.target.value)}
                              className={form.errors.inlineTelefon ? "border-destructive" : ""}
                              data-testid="input-inline-telefon"
                            />
                            {form.errors.inlineTelefon && <p className="text-destructive text-xs">{form.errors.inlineTelefon}</p>}
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="inline-email">
                              <Mail className={`${iconSize.sm} inline mr-1`} /> E-Mail
                            </Label>
                            <Input
                              id="inline-email"
                              type="email"
                              placeholder="beispiel@email.de"
                              value={form.inlineProspectEmail}
                              onChange={(e) => form.setInlineProspectEmail(e.target.value)}
                              data-testid="input-inline-email"
                            />
                          </div>
                        </div>
                        <div className="mt-3">
                          <Label className="flex items-center gap-1 mb-2">
                            <Home className={iconSize.sm} /> Adresse
                          </Label>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <div className="col-span-2 space-y-1">
                              <Input
                                placeholder="Straße"
                                value={form.inlineProspectStrasse}
                                onChange={(e) => form.setInlineProspectStrasse(e.target.value)}
                                data-testid="input-inline-strasse"
                              />
                            </div>
                            <div className="space-y-1">
                              <Input
                                placeholder="Nr."
                                value={form.inlineProspectNr}
                                onChange={(e) => form.setInlineProspectNr(e.target.value)}
                                data-testid="input-inline-nr"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                            <div className="space-y-1">
                              <Input
                                placeholder="PLZ"
                                maxLength={5}
                                value={form.inlineProspectPlz}
                                onChange={(e) => form.setInlineProspectPlz(e.target.value)}
                                data-testid="input-inline-plz"
                              />
                            </div>
                            <div className="col-span-2 space-y-1">
                              <Input
                                placeholder="Stadt"
                                value={form.inlineProspectStadt}
                                onChange={(e) => form.setInlineProspectStadt(e.target.value)}
                                data-testid="input-inline-stadt"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 space-y-1">
                          <Label>Pflegegrad</Label>
                          <Select value={form.inlineProspectPflegegrad} onValueChange={form.setInlineProspectPflegegrad}>
                            <SelectTrigger data-testid="select-inline-pflegegrad">
                              <SelectValue placeholder="Pflegegrad wählen..." />
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
                        <Button
                          className="mt-4 w-full"
                          onClick={form.handleInlineProspectCreate}
                          disabled={form.isCreatingProspect}
                          data-testid="button-create-inline-prospect"
                        >
                          {form.isCreatingProspect ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : <UserPlus className={`${iconSize.sm} mr-2`} />}
                          Interessent anlegen & weiter
                        </Button>
                      </div>
                      <div className="relative flex items-center justify-center">
                        <div className="absolute inset-0 flex items-center"><div className="w-full border-t" /></div>
                        <span className="relative bg-card px-3 text-xs text-muted-foreground">oder</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setLocation("/admin/prospects")}
                        data-testid="button-go-prospects"
                      >
                        Bestehenden Interessenten in der Verwaltung auswählen
                      </Button>
                    </>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" data-testid="banner-no-prospect">
                      <p className="font-medium">Kein Interessent ausgewählt</p>
                      <p className="mt-1">Erstberatungen werden über die Interessenten-Verwaltung erstellt. Bitte wenden Sie sich an einen Administrator.</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {form.prospectData && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="panel-prospect-info">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-blue-800 font-medium">
                          <UserCheck className={iconSize.sm} />
                          <span>Interessent</span>
                        </div>
                        {!editingEbContact && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-blue-700 hover:text-blue-900" onClick={startEditingEbContact} data-testid="button-edit-eb-contact">
                            <Pencil className="h-3 w-3" /> Bearbeiten
                          </Button>
                        )}
                      </div>
                      {editingEbContact ? (
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-blue-800 mb-1">{form.prospectData.vorname} {form.prospectData.nachname}</div>
                          <div className="space-y-1">
                            <Label className="text-xs text-blue-600">Telefon</Label>
                            <Input value={ebEditTelefon} onChange={(e) => setEbEditTelefon(e.target.value)} placeholder="z.B. 0151 12345678" className="bg-white" data-testid="input-eb-edit-telefon" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-blue-600">E-Mail</Label>
                            <Input value={ebEditEmail} onChange={(e) => setEbEditEmail(e.target.value)} placeholder="E-Mail-Adresse" type="email" className="bg-white" data-testid="input-eb-edit-email" />
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2 space-y-1">
                              <Label className="text-xs text-blue-600">Straße</Label>
                              <Input value={ebEditStrasse} onChange={(e) => setEbEditStrasse(e.target.value)} placeholder="Straße" className="bg-white" data-testid="input-eb-edit-strasse" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs text-blue-600">Nr.</Label>
                              <Input value={ebEditNr} onChange={(e) => setEbEditNr(e.target.value)} placeholder="Nr." className="bg-white" data-testid="input-eb-edit-nr" />
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs text-blue-600">PLZ</Label>
                              <Input value={ebEditPlz} onChange={(e) => setEbEditPlz(e.target.value)} placeholder="PLZ" maxLength={5} className="bg-white" data-testid="input-eb-edit-plz" />
                            </div>
                            <div className="col-span-2 space-y-1">
                              <Label className="text-xs text-blue-600">Stadt</Label>
                              <Input value={ebEditStadt} onChange={(e) => setEbEditStadt(e.target.value)} placeholder="Stadt" className="bg-white" data-testid="input-eb-edit-stadt" />
                            </div>
                          </div>
                          <div className="flex gap-2 pt-1">
                            <Button size="sm" className="flex-1" onClick={handleSaveEbContact} disabled={updateProspectMutation.isPending} data-testid="button-save-eb-contact">
                              {updateProspectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                              Speichern
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingEbContact(false)} data-testid="button-cancel-eb-contact">
                              <X className="h-3.5 w-3.5 mr-1" /> Abbrechen
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-2 text-sm text-blue-700">
                          <div><span className="text-blue-500">Name:</span> {form.prospectData.vorname} {form.prospectData.nachname}</div>
                          {form.prospectData.telefon && <div><span className="text-blue-500">Telefon:</span> {form.prospectData.telefon}</div>}
                          {form.prospectData.email && <div><span className="text-blue-500">E-Mail:</span> {form.prospectData.email}</div>}
                          {form.prospectData.strasse && (
                            <div className="col-span-2"><span className="text-blue-500">Adresse:</span> {form.prospectData.strasse} {form.prospectData.nr}, {form.prospectData.plz} {form.prospectData.stadt}</div>
                          )}
                          {!form.prospectData.telefon && !form.prospectData.email && !form.prospectData.strasse && (
                            <div className="col-span-2 text-blue-400 italic">Keine Kontaktdaten — <button className="underline" onClick={startEditingEbContact}>jetzt ergänzen</button></div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {form.errors.ebProspect && <p className="text-destructive text-sm">{form.errors.ebProspect}</p>}

                  {form.isAdmin && (
                    <div className="space-y-2">
                      <Label>
                        <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                      </Label>
                      <SearchableSelect
                        options={form.ebEmployeeOptions}
                        value={form.ebAssignedEmployeeId}
                        onValueChange={form.setEbAssignedEmployeeId}
                        placeholder="Mitarbeiter auswählen..."
                        searchPlaceholder="Mitarbeiter suchen..."
                        emptyText="Kein Mitarbeiter mit Erstberatungs-Berechtigung gefunden."
                        className={form.errors.ebAssignedEmployeeId ? "border-destructive" : ""}
                        data-testid="select-eb-employee"
                      />
                      {form.errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{form.errors.ebAssignedEmployeeId}</p>}
                    </div>
                  )}

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

                  {form.isAdmin && form.ebDate && (
                    <EmployeeAvailability
                      date={form.ebDate}
                      selectedEmployeeId={form.ebAssignedEmployeeId}
                      onSelectEmployee={form.setEbAssignedEmployeeId}
                    />
                  )}

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
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
