import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, Calendar, Clock, User, Plus, Users, UserCheck, Phone, UserPlus, Pencil, Check, X, Home, Mail, Search } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { AppointmentSummary } from "@/features/appointments";
import { EmployeeAvailability } from "@/features/appointments/components/employee-availability";
import { AddressFields } from "@/features/customers/components/wizard/address-fields";
import { isDachPhone } from "@shared/schema/common";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import type { Prospect } from "@shared/schema";
import { useUpdateProspect } from "@/features/prospects";
import { api, unwrapResult } from "@/lib/api/client";
import type { useNewAppointmentForm } from "@/features/appointments/hooks/use-new-appointment-form";

type AppointmentForm = ReturnType<typeof useNewAppointmentForm>;

const ELIGIBLE_STATUSES = "neu,kontaktiert,wiedervorlage,qualifiziert";
const STATUS_BADGE_LABELS: Record<string, string> = {
  neu: "Neu",
  kontaktiert: "Kontaktiert",
  wiedervorlage: "Wiedervorlage",
  qualifiziert: "Qualifiziert",
};

export function NewAppointmentErstberatungTab({ form, onBack }: { form: AppointmentForm; onBack: () => void }) {
  const updateProspectMutation = useUpdateProspect();
  const [editingEbContact, setEditingEbContact] = useState(false);
  const [ebEditTelefon, setEbEditTelefon] = useState("");
  const [ebEditEmail, setEbEditEmail] = useState("");
  const [ebEditStrasse, setEbEditStrasse] = useState("");
  const [ebEditNr, setEbEditNr] = useState("");
  const [ebEditPlz, setEbEditPlz] = useState("");
  const [ebEditStadt, setEbEditStadt] = useState("");
  const [ebEditPflegegrad, setEbEditPflegegrad] = useState("");
  const [ebEditErrors, setEbEditErrors] = useState<Record<string, string>>({});

  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleProspectSearch = useCallback((term: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(term), 300);
  }, []);
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const { data: availableProspects = [], isLoading: prospectsLoading } = useQuery<Prospect[]>({
    queryKey: ["prospects-for-erstberatung", debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ status: ELIGIBLE_STATUSES });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const result = await api.get<Prospect[]>(`/prospects/search?${params}`);
      return unwrapResult(result);
    },
    staleTime: 30_000,
    enabled: form.prospectMode === "existing" && !form.fromProspectId,
  });

  const prospectOptions = availableProspects.map((p) => ({
    value: p.id.toString(),
    label: `${p.vorname} ${p.nachname}`,
    sublabel: [p.telefon, p.email, STATUS_BADGE_LABELS[p.status as string] || p.status].filter(Boolean).join(" · "),
  }));

  const startEditingEbContact = () => {
    if (!form.prospectData) return;
    setEbEditTelefon(form.prospectData.telefon || "");
    setEbEditEmail(form.prospectData.email || "");
    setEbEditStrasse(form.prospectData.strasse || "");
    setEbEditNr(form.prospectData.nr || "");
    setEbEditPlz(form.prospectData.plz || "");
    setEbEditStadt(form.prospectData.stadt || "");
    setEbEditPflegegrad(form.prospectData.pflegegrad ? form.prospectData.pflegegrad.toString() : "");
    setEbEditErrors({});
    setEditingEbContact(true);
  };

  const handleEbAddressChange = (field: string, value: string) => {
    if (field === "strasse") setEbEditStrasse(value);
    else if (field === "nr") setEbEditNr(value);
    else if (field === "plz") setEbEditPlz(value);
    else if (field === "stadt") setEbEditStadt(value);
  };

  const handleInlineAddressChange = (field: string, value: string) => {
    if (field === "strasse") form.setInlineProspectStrasse(value);
    else if (field === "nr") form.setInlineProspectNr(value);
    else if (field === "plz") form.setInlineProspectPlz(value);
    else if (field === "stadt") form.setInlineProspectStadt(value);
  };

  const handleSaveEbContact = () => {
    if (!form.prospectData) return;
    const errs: Record<string, string> = {};
    if (ebEditTelefon.trim() && !isDachPhone(ebEditTelefon.trim())) {
      errs.telefon = "Ungültige Telefonnummer (DE/AT/CH)";
    }
    if (ebEditEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ebEditEmail.trim())) {
      errs.email = "Ungültige E-Mail-Adresse";
    }
    if (ebEditPlz.trim() && !/^\d{5}$/.test(ebEditPlz.trim())) {
      errs.plz = "PLZ muss 5 Ziffern haben";
    }
    setEbEditErrors(errs);
    if (Object.keys(errs).length > 0) return;
    updateProspectMutation.mutate({
      id: form.prospectData.id,
      data: {
        telefon: ebEditTelefon.trim() || null,
        email: ebEditEmail.trim() || null,
        strasse: ebEditStrasse.trim() || null,
        nr: ebEditNr.trim() || null,
        plz: ebEditPlz.trim() || null,
        stadt: ebEditStadt.trim() || null,
        pflegegrad: ebEditPflegegrad ? parseInt(ebEditPflegegrad) : null,
      },
    }, {
      onSuccess: () => setEditingEbContact(false),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Erstberatung für Interessenten</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
              {!form.fromProspectId ? (
                <div className="space-y-4">
                  <div className="flex gap-2" data-testid="panel-prospect-mode-toggle">
                    <Button
                      variant={form.prospectMode === "existing" ? "default" : "outline"}
                      size="sm"
                      onClick={() => form.setProspectMode("existing")}
                      className="flex-1"
                      data-testid="button-prospect-mode-existing"
                    >
                      <Search className={`${iconSize.sm} mr-2`} />
                      Bestehenden auswählen
                    </Button>
                    <Button
                      variant={form.prospectMode === "new" ? "default" : "outline"}
                      size="sm"
                      onClick={() => { form.setProspectMode("new"); form.clearSelectedProspect(); }}
                      className="flex-1"
                      data-testid="button-prospect-mode-new"
                    >
                      <UserPlus className={`${iconSize.sm} mr-2`} />
                      Neu anlegen
                    </Button>
                  </div>

                  {form.prospectMode === "existing" && !form.selectedExistingProspectId && (
                    <div className="rounded-lg border border-teal-200 bg-teal-50 p-4" data-testid="panel-prospect-search">
                      <div className="flex items-center gap-2 text-teal-800 font-medium mb-3">
                        <Search className={iconSize.sm} />
                        <span>Bestehenden Interessenten auswählen</span>
                      </div>
                      <SearchableSelect
                        options={prospectOptions}
                        value=""
                        onValueChange={(val) => {
                          form.setSelectedExistingProspectId(Number(val));
                        }}
                        placeholder="Interessent suchen…"
                        searchPlaceholder="Name, Telefon oder E-Mail…"
                        emptyText={prospectsLoading ? "Wird geladen…" : "Keine passenden Interessenten gefunden."}
                        isLoading={prospectsLoading}
                        data-testid="select-existing-prospect"
                        onSearchChange={handleProspectSearch}
                        serverSideSearch
                      />
                      <p className="text-xs text-teal-600 mt-2">
                        Zeigt Interessenten mit Status: Neu, Kontaktiert, Wiedervorlage, Qualifiziert
                      </p>
                    </div>
                  )}

                  {form.prospectMode === "new" && (
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
                          className={form.errors.inlineEmail ? "border-destructive" : ""}
                          data-testid="input-inline-email"
                        />
                        {form.errors.inlineEmail && <p className="text-destructive text-xs">{form.errors.inlineEmail}</p>}
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <Label className="flex items-center gap-1">
                        <Home className={iconSize.sm} /> Adresse
                      </Label>
                      <AddressFields
                        strasse={form.inlineProspectStrasse}
                        nr={form.inlineProspectNr}
                        plz={form.inlineProspectPlz}
                        stadt={form.inlineProspectStadt}
                        onChange={handleInlineAddressChange}
                        testIdPrefix="inline"
                      />
                      {form.errors.inlinePlz && <p className="text-destructive text-xs">{form.errors.inlinePlz}</p>}
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
                  )}
                </div>
              ) : (
                <>
                  {!form.prospectData && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-center justify-between" data-testid="panel-prospect-loading">
                      <div className="flex items-center gap-2 text-blue-700">
                        <Loader2 className={`${iconSize.sm} animate-spin`} />
                        <span className="text-sm">Interessent wird geladen…</span>
                      </div>
                      {form.selectedExistingProspectId && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-blue-700 hover:text-blue-900" onClick={() => form.clearSelectedProspect()} data-testid="button-change-prospect-loading">
                          <X className="h-3 w-3" /> Ändern
                        </Button>
                      )}
                    </div>
                  )}
                  {form.prospectData && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="panel-prospect-info">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-blue-800 font-medium">
                          <UserCheck className={iconSize.sm} />
                          <span>Interessent</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {form.selectedExistingProspectId && !editingEbContact && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-blue-700 hover:text-blue-900" onClick={() => form.clearSelectedProspect()} data-testid="button-change-selected-prospect">
                              <X className="h-3 w-3" /> Ändern
                            </Button>
                          )}
                          {!editingEbContact && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-blue-700 hover:text-blue-900" onClick={startEditingEbContact} data-testid="button-edit-eb-contact">
                              <Pencil className="h-3 w-3" /> Bearbeiten
                            </Button>
                          )}
                        </div>
                      </div>
                      {editingEbContact ? (
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-blue-800 mb-1">{form.prospectData.vorname} {form.prospectData.nachname}</div>
                          <div className="space-y-1">
                            <Label className="text-xs text-blue-600">Telefon</Label>
                            <Input value={ebEditTelefon} onChange={(e) => setEbEditTelefon(e.target.value)} placeholder="z.B. 0151 12345678" className={`bg-white ${ebEditErrors.telefon ? "border-destructive" : ""}`} data-testid="input-eb-edit-telefon" />
                            {ebEditErrors.telefon && <p className="text-destructive text-xs">{ebEditErrors.telefon}</p>}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-blue-600">E-Mail</Label>
                            <Input value={ebEditEmail} onChange={(e) => setEbEditEmail(e.target.value)} placeholder="E-Mail-Adresse" type="email" className={`bg-white ${ebEditErrors.email ? "border-destructive" : ""}`} data-testid="input-eb-edit-email" />
                            {ebEditErrors.email && <p className="text-destructive text-xs">{ebEditErrors.email}</p>}
                          </div>
                          <AddressFields
                            strasse={ebEditStrasse}
                            nr={ebEditNr}
                            plz={ebEditPlz}
                            stadt={ebEditStadt}
                            onChange={handleEbAddressChange}
                            testIdPrefix="eb-edit"
                          />
                          {ebEditErrors.plz && <p className="text-destructive text-xs">{ebEditErrors.plz}</p>}
                          <div className="space-y-1">
                            <Label className="text-xs text-blue-600">Pflegegrad</Label>
                            <Select value={ebEditPflegegrad} onValueChange={setEbEditPflegegrad}>
                              <SelectTrigger className="bg-white" data-testid="select-eb-edit-pflegegrad">
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
                          {form.prospectData.pflegegrad && (
                            <div><span className="text-blue-500">Pflegegrad:</span> {form.prospectData.pflegegrad}</div>
                          )}
                          {!form.prospectData.telefon && !form.prospectData.email && !form.prospectData.strasse && (
                            <div className="col-span-2 text-blue-400 italic">Keine Kontaktdaten — <button className="underline" onClick={startEditingEbContact}>jetzt ergänzen</button></div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {form.errors.ebProspect && <p className="text-destructive text-sm">{form.errors.ebProspect}</p>}

                  {form.canChangeAssignment && (
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
                  <Button
                    variant="outline"
                    className="w-full mt-2"
                    size="lg"
                    onClick={onBack}
                    disabled={form.isPending}
                    data-testid="button-cancel-erstberatung"
                  >
                    Abbrechen
                  </Button>
                </>
              )}
      </CardContent>
    </Card>
  );
}
