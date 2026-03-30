import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, Loader2, Calendar, Clock, User, Plus, Users, AlertTriangle, XCircle, CheckCircle2, Copy, UserCheck, Phone, UserPlus, Pencil, Check, X, Home, Mail, Repeat, Search } from "lucide-react";
import { WEEKDAYS, type Weekday } from "@shared/schema/appointments";
import { WEEKDAY_LABELS, formatWeekdays } from "@/features/appointments/hooks/use-appointment-series";
import { iconSize, componentStyles } from "@/design-system";
import { useNewAppointmentForm, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { EmployeeAvailability } from "@/features/appointments/components/employee-availability";
import { AddressFields } from "@/pages/admin/components/address-fields";
import { isDachPhone } from "@shared/schema/common";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import type { Prospect } from "@shared/schema";
import { useLocation } from "wouter";
import { useUpdateProspect } from "@/features/prospects";
import { api, unwrapResult } from "@/lib/api/client";

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
  const [ebEditErrors, setEbEditErrors] = useState<Record<string, string>>({});

  const ELIGIBLE_STATUSES = "neu,kontaktiert,wiedervorlage,qualifiziert";
  const { data: availableProspects = [], isLoading: prospectsLoading } = useQuery<Prospect[]>({
    queryKey: ["prospects-for-erstberatung"],
    queryFn: async () => {
      const params = new URLSearchParams({ status: ELIGIBLE_STATUSES });
      const result = await api.get<Prospect[]>(`/admin/prospects?${params}`);
      return unwrapResult(result);
    },
    staleTime: 30_000,
    enabled: form.prospectMode === "existing" && !form.fromProspectId,
  });

  const prospectOptions = useMemo(() =>
    availableProspects.map((p) => {
      const parts = [`${p.vorname} ${p.nachname}`];
      if (p.telefon) parts.push(p.telefon);
      if (p.email) parts.push(p.email);
      return {
        value: p.id.toString(),
        label: parts.join(" — "),
      };
    }),
    [availableProspects]
  );

  const startEditingEbContact = () => {
    if (!form.prospectData) return;
    setEbEditTelefon(form.prospectData.telefon || "");
    setEbEditEmail(form.prospectData.email || "");
    setEbEditStrasse(form.prospectData.strasse || "");
    setEbEditNr(form.prospectData.nr || "");
    setEbEditPlz(form.prospectData.plz || "");
    setEbEditStadt(form.prospectData.stadt || "");
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
        {form.canErstberatung ? (
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="kundentermin" data-testid="tab-kundentermin">
              <User className={`${iconSize.sm} mr-2`} /> Kundentermin
            </TabsTrigger>
            <TabsTrigger value="erstberatung" data-testid="tab-erstberatung">
              <Plus className={`${iconSize.sm} mr-2`} /> Erstberatung
            </TabsTrigger>
          </TabsList>
        ) : (
          <TabsList className="grid w-full grid-cols-1 mb-6">
            <TabsTrigger value="kundentermin" data-testid="tab-kundentermin">
              <User className={`${iconSize.sm} mr-2`} /> Kundentermin
            </TabsTrigger>
          </TabsList>
        )}

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

              {form.costEstimate?.noPricing && (
                <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-no-pricing">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-amber-800 font-semibold">Keine Preisvereinbarung</p>
                    <p className="text-amber-700 text-xs mt-1">Bitte hinterlegen Sie eine Preisvereinbarung für diesen Kunden.</p>
                  </div>
                </div>
              )}

              {form.costEstimate && !form.costEstimate.noPricing && form.costEstimate.totalCents > 0 && (() => {
                const cost = form.costEstimate;
                const costEuro = (cost.totalCents / 100).toFixed(2).replace(".", ",");
                const availEuro = cost.availableCents !== undefined ? (cost.availableCents / 100).toFixed(2).replace(".", ",") : null;

                if (cost.isHardBlock) {
                  return (
                    <div className="rounded-lg border bg-red-50 border-red-300 p-4 text-sm flex items-start gap-3" data-testid="budget-hard-block">
                      <XCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-red-800 font-semibold">Budget reicht nicht</p>
                        <p className="text-red-700 mt-1">Kosten: {costEuro} € — {availEuro !== null ? `verfügbar: ${availEuro} €` : "kein Budget"}</p>
                        <p className="text-red-600 text-xs mt-1">{cost.warning}</p>
                      </div>
                    </div>
                  );
                }

                if (cost.warning) {
                  return (
                    <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-warning">
                      <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-amber-800 font-semibold">Kosten: {costEuro} € {availEuro !== null && <span className="font-normal">— verfügbar: {availEuro} €</span>}</p>
                        <p className="text-amber-700 text-xs mt-1">{cost.warning}</p>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="rounded-lg border bg-green-50 border-green-200 p-3 text-sm flex items-start gap-3" data-testid="budget-cost-estimate">
                    <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-green-800 font-medium">Kosten: {costEuro} € {availEuro !== null && <span className="font-normal text-green-600">— verfügbar: {availEuro} €</span>}</p>
                    </div>
                  </div>
                );
              })()}

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
            </CardContent>
          </Card>
        </TabsContent>

        {form.canErstberatung && (
        <TabsContent value="erstberatung">
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
                      onClick={() => form.setProspectMode("new")}
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
        )}
      </Tabs>

      <AlertDialog open={form.showSeriesConflictDialog} onOpenChange={(open) => { if (!open && !form.isSeriesCreating) form.dismissSeriesConflictDialog(); }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-amber-500`} />
              Terminkonflikt erkannt
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {form.seriesConflictInfo && form.seriesConflictInfo.validDates > 0 ? (
                  <span>
                    <strong>{form.seriesConflicts.length}</strong> von <strong>{form.seriesConflictInfo.totalDates}</strong> Terminen haben Konflikte. Diese Tage werden übersprungen und <strong>{form.seriesConflictInfo.validDates}</strong> Termine werden erstellt.
                  </span>
                ) : (
                  <span>
                    Alle {form.seriesConflicts.length} Termine haben Konflikte. Es können keine Termine erstellt werden.
                  </span>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {form.seriesConflicts.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-1 py-2">
              {form.seriesConflicts.map((c, i) => (
                <div key={i} className="flex items-start gap-2 py-1 px-2 rounded bg-destructive/5 text-sm" data-testid={`conflict-${i}`}>
                  <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">
                      {new Date(c.date + "T00:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}
                    </span>
                    <span className="text-muted-foreground ml-2">{c.reason}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={form.dismissSeriesConflictDialog}
              disabled={form.isSeriesCreating}
              data-testid="button-cancel-series-create"
            >
              Abbrechen
            </Button>
            {form.seriesConflictInfo && form.seriesConflictInfo.validDates > 0 && (
              <Button
                onClick={form.confirmSeriesWithSkippedConflicts}
                className={componentStyles.btnPrimary}
                disabled={form.isSeriesCreating}
                data-testid="button-confirm-skip-conflicts"
              >
                {form.isSeriesCreating ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                Konflikte überspringen & erstellen
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
