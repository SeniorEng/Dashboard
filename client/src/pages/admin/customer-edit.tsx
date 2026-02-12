/**
 * Admin Customer Edit Page
 * 
 * Form for editing existing customer data including personal info,
 * contact details, and employee assignments.
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { useToast } from "@/hooks/use-toast";
import { useCustomer, useUpdateCustomer, useEmployees, customerKeys } from "@/features/customers";
import { api, unwrapResult } from "@/lib/api";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO } from "@shared/utils/datetime";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  User2,
  MapPin,
  Phone,
  Users,
  Save,
  CreditCard,
  Heart,
  Stethoscope,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { PFLEGEGRAD_SELECT_OPTIONS } from "@shared/domain/customers";
import { AddressFields } from "./components/address-fields";

export default function AdminCustomerEdit() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customer, isLoading } = useCustomer(customerId);
  const { data: employees } = useEmployees();
  const updateMutation = useUpdateCustomer();

  const [newPflegegrad, setNewPflegegrad] = useState<string>("");
  const [pflegegradSeit, setPflegegradSeit] = useState<string>(todayISO());

  const changeCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; validFrom: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad aktualisiert", description: "Der Pflegegrad wurde mit Historisierung gespeichert." });
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
      queryClient.invalidateQueries({ queryKey: customerKeys.lists() });
      setNewPflegegrad("");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const employeeOptions = useMemo(() => [
    { value: "", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

  const [formData, setFormData] = useState({
    vorname: "",
    nachname: "",
    email: "",
    telefon: "",
    festnetz: "",
    strasse: "",
    nr: "",
    plz: "",
    stadt: "",
    geburtsdatum: "",
    primaryEmployeeId: "",
    backupEmployeeId: "",
    vorerkrankungen: "",
    haustierVorhanden: false,
    haustierDetails: "",
    acceptsPrivatePayment: false,
  });

  const [phoneErrors, setPhoneErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (customer) {
      setFormData({
        vorname: customer.vorname || "",
        nachname: customer.nachname || "",
        email: customer.email || "",
        telefon: customer.telefon || "",
        festnetz: customer.festnetz || "",
        strasse: customer.strasse || "",
        nr: customer.nr || "",
        plz: customer.plz || "",
        stadt: customer.stadt || "",
        geburtsdatum: customer.geburtsdatum || "",
        primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
        backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
        vorerkrankungen: customer.vorerkrankungen || "",
        haustierVorhanden: customer.haustierVorhanden ?? false,
        haustierDetails: customer.haustierDetails || "",
        acceptsPrivatePayment: customer.acceptsPrivatePayment ?? false,
      });
    }
  }, [customer]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handlePhoneChange = (field: "telefon" | "festnetz", value: string) => {
    const formatted = formatPhoneAsYouType(value);
    setFormData((prev) => ({ ...prev, [field]: formatted }));
    
    if (formatted.length > 3) {
      const validation = validateGermanPhone(formatted);
      setPhoneErrors((prev) => ({
        ...prev,
        [field]: validation.valid ? null : "Ungültige Telefonnummer",
      }));
    } else {
      setPhoneErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const handleSubmit = () => {
    if (!formData.vorname.trim() || !formData.nachname.trim()) {
      toast({
        title: "Pflichtfelder fehlen",
        description: "Vorname und Nachname sind erforderlich.",
        variant: "destructive",
      });
      return;
    }

    if (phoneErrors.telefon || phoneErrors.festnetz) {
      toast({
        title: "Ungültige Telefonnummer",
        description: "Bitte korrigieren Sie die Telefonnummer(n).",
        variant: "destructive",
      });
      return;
    }

    const primaryId = formData.primaryEmployeeId ? parseInt(formData.primaryEmployeeId) : null;
    const backupId = formData.backupEmployeeId ? parseInt(formData.backupEmployeeId) : null;

    if (primaryId && backupId && primaryId === backupId) {
      toast({
        title: "Ungültige Auswahl",
        description: "Haupt- und Vertretungsmitarbeiter dürfen nicht identisch sein.",
        variant: "destructive",
      });
      return;
    }

    const data: Record<string, unknown> = {
      vorname: formData.vorname.trim(),
      nachname: formData.nachname.trim(),
      geburtsdatum: formData.geburtsdatum?.trim() || null,
      email: formData.email.trim() || null,
      telefon: formData.telefon.trim() ? normalizePhone(formData.telefon) : null,
      festnetz: formData.festnetz.trim() ? normalizePhone(formData.festnetz) : null,
      strasse: formData.strasse.trim() || null,
      nr: formData.nr.trim() || null,
      plz: formData.plz.trim() || null,
      stadt: formData.stadt.trim() || null,
      primaryEmployeeId: primaryId,
      backupEmployeeId: backupId,
      vorerkrankungen: formData.vorerkrankungen?.trim() || null,
      haustierVorhanden: formData.haustierVorhanden ?? false,
      haustierDetails: formData.haustierVorhanden ? (formData.haustierDetails?.trim() || null) : null,
      acceptsPrivatePayment: formData.acceptsPrivatePayment,
    };

    updateMutation.mutate(
      { id: customerId, data },
      {
        onSuccess: () => {
          toast({ title: "Kunde aktualisiert", description: "Die Änderungen wurden gespeichert." });
          setLocation(`/admin/customers/${customerId}`);
        },
        onError: (error: Error) => {
          toast({
            title: "Fehler",
            description: error.message || "Kunde konnte nicht aktualisiert werden.",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] flex items-center justify-center">
          <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
        </div>
      </Layout>
    );
  }

  if (!customer) {
    return (
      <Layout>
        <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
          <div className="container mx-auto px-4 py-6 max-w-2xl">
            <PageHeader title="Kunde nicht gefunden" backHref="/admin/customers" />
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-2xl">
          <PageHeader
            title="Kunde bearbeiten"
            backHref={`/admin/customers/${customerId}`}
          />

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <User2 className={iconSize.sm} />
                  Persönliche Daten
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="vorname">Vorname *</Label>
                    <Input
                      id="vorname"
                      value={formData.vorname}
                      onChange={(e) => handleChange("vorname", e.target.value)}
                      placeholder="Vorname"
                      data-testid="input-vorname"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nachname">Nachname *</Label>
                    <Input
                      id="nachname"
                      value={formData.nachname}
                      onChange={(e) => handleChange("nachname", e.target.value)}
                      placeholder="Nachname"
                      data-testid="input-nachname"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Geburtsdatum</Label>
                  <DatePicker
                    value={formData.geburtsdatum || null}
                    onChange={(val) => handleChange("geburtsdatum", val || "")}
                    data-testid="input-geburtsdatum"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">E-Mail</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => handleChange("email", e.target.value)}
                    placeholder="email@beispiel.de"
                    data-testid="input-email"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Heart className={iconSize.sm} />
                  Pflegegrad
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
                  <span className="text-sm text-gray-600">Aktueller Pflegegrad:</span>
                  {customer && customer.pflegegrad && customer.pflegegrad > 0 ? (
                    <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                  ) : (
                    <span className="text-sm text-gray-400">Nicht festgelegt</span>
                  )}
                </div>

                <div className="border-t pt-4">
                  <p className="text-sm font-medium mb-3">Pflegegrad ändern</p>
                  <p className="text-xs text-gray-500 mb-3">
                    Der bisherige Pflegegrad wird mit Enddatum gespeichert und bleibt für Budgets und Rechnungen nachvollziehbar.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Neuer Pflegegrad</Label>
                      <Select value={newPflegegrad} onValueChange={setNewPflegegrad}>
                        <SelectTrigger data-testid="select-new-pflegegrad">
                          <SelectValue placeholder="Auswählen" />
                        </SelectTrigger>
                        <SelectContent>
                          {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Gültig ab</Label>
                      <DatePicker
                        value={pflegegradSeit}
                        onChange={(val) => setPflegegradSeit(val || todayISO())}
                        data-testid="input-pflegegrad-seit"
                      />
                    </div>
                  </div>
                  {newPflegegrad && (
                    <Button
                      className={`mt-3 w-full ${componentStyles.btnPrimary}`}
                      onClick={() => {
                        changeCareLevelMutation.mutate({
                          pflegegrad: parseInt(newPflegegrad),
                          validFrom: pflegegradSeit,
                        });
                      }}
                      disabled={changeCareLevelMutation.isPending}
                      data-testid="button-save-pflegegrad"
                    >
                      {changeCareLevelMutation.isPending ? (
                        <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                      ) : (
                        <Save className={`${iconSize.sm} mr-2`} />
                      )}
                      Pflegegrad ändern
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Phone className={iconSize.sm} />
                  Kontakt
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="telefon">Mobiltelefon</Label>
                  <Input
                    id="telefon"
                    value={formData.telefon}
                    onChange={(e) => handlePhoneChange("telefon", e.target.value)}
                    placeholder="+49 170 1234567"
                    className={phoneErrors.telefon ? "border-red-500" : ""}
                    data-testid="input-telefon"
                  />
                  {phoneErrors.telefon && (
                    <p className="text-sm text-red-500">{phoneErrors.telefon}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="festnetz">Festnetz</Label>
                  <Input
                    id="festnetz"
                    value={formData.festnetz}
                    onChange={(e) => handlePhoneChange("festnetz", e.target.value)}
                    placeholder="+49 30 1234567"
                    className={phoneErrors.festnetz ? "border-red-500" : ""}
                    data-testid="input-festnetz"
                  />
                  {phoneErrors.festnetz && (
                    <p className="text-sm text-red-500">{phoneErrors.festnetz}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <MapPin className={iconSize.sm} />
                  Adresse
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <AddressFields
                  strasse={formData.strasse}
                  nr={formData.nr}
                  plz={formData.plz}
                  stadt={formData.stadt}
                  onChange={handleChange}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Users className={iconSize.sm} />
                  Zuständige Mitarbeiter
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Hauptzuständig</Label>
                  <SearchableSelect
                    options={employeeOptions}
                    value={formData.primaryEmployeeId}
                    onValueChange={(value) => handleChange("primaryEmployeeId", value)}
                    placeholder="Mitarbeiter auswählen"
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    data-testid="select-primary-employee"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Vertretung</Label>
                  <SearchableSelect
                    options={employeeOptions}
                    value={formData.backupEmployeeId}
                    onValueChange={(value) => handleChange("backupEmployeeId", value)}
                    placeholder="Mitarbeiter auswählen"
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    data-testid="select-backup-employee"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Stethoscope className={iconSize.sm} />
                  Gesundheit & Haustier
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="vorerkrankungen">Vorerkrankungen</Label>
                  <Textarea
                    id="vorerkrankungen"
                    value={formData.vorerkrankungen}
                    onChange={(e) => handleChange("vorerkrankungen", e.target.value)}
                    placeholder="Bekannte Vorerkrankungen, Allergien, Medikamente..."
                    rows={3}
                    maxLength={2000}
                    data-testid="input-vorerkrankungen"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="haustierVorhanden">Haustier vorhanden</Label>
                    <p className="text-sm text-muted-foreground">
                      Relevant für die Einsatzplanung der Mitarbeiter
                    </p>
                  </div>
                  <Switch
                    id="haustierVorhanden"
                    checked={formData.haustierVorhanden}
                    onCheckedChange={(checked) => setFormData(prev => ({ ...prev, haustierVorhanden: checked }))}
                    data-testid="switch-haustier-vorhanden"
                  />
                </div>

                {formData.haustierVorhanden && (
                  <div className="space-y-2">
                    <Label htmlFor="haustierDetails">Haustier-Details</Label>
                    <Input
                      id="haustierDetails"
                      value={formData.haustierDetails}
                      onChange={(e) => handleChange("haustierDetails", e.target.value)}
                      placeholder="z.B. Hund (Golden Retriever), Katze..."
                      maxLength={500}
                      data-testid="input-haustier-details"
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CreditCard className={iconSize.sm} />
                  Abrechnung
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="acceptsPrivatePayment">Akzeptiert private Zuzahlung</Label>
                    <p className="text-sm text-muted-foreground">
                      Restbeträge über das Budget hinaus werden dem Kunden privat mit MwSt. berechnet
                    </p>
                  </div>
                  <Switch
                    id="acceptsPrivatePayment"
                    checked={formData.acceptsPrivatePayment}
                    onCheckedChange={(checked) => setFormData(prev => ({ ...prev, acceptsPrivatePayment: checked }))}
                    data-testid="switch-accepts-private-payment"
                  />
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setLocation(`/admin/customers/${customerId}`)}
                data-testid="button-cancel"
              >
                Abbrechen
              </Button>
              <Button
                className={`flex-1 ${componentStyles.btnPrimary}`}
                onClick={handleSubmit}
                disabled={updateMutation.isPending}
                data-testid="button-save"
              >
                {updateMutation.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
