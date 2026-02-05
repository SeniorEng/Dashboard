/**
 * Admin Customer Edit Page
 * 
 * Form for editing existing customer data including personal info,
 * contact details, and employee assignments.
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { useToast } from "@/hooks/use-toast";
import { useCustomer, useUpdateCustomer, useEmployees } from "@/features/customers";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import {
  Loader2,
  User2,
  MapPin,
  Phone,
  Users,
  Save,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";

const PFLEGEGRAD_OPTIONS = [
  { value: "0", label: "Ohne Pflegegrad" },
  { value: "1", label: "Pflegegrad 1" },
  { value: "2", label: "Pflegegrad 2" },
  { value: "3", label: "Pflegegrad 3" },
  { value: "4", label: "Pflegegrad 4" },
  { value: "5", label: "Pflegegrad 5" },
];

export default function AdminCustomerEdit() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: customer, isLoading } = useCustomer(customerId);
  const { data: employees } = useEmployees();
  const updateMutation = useUpdateCustomer();

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
    pflegegrad: "0",
    primaryEmployeeId: "",
    backupEmployeeId: "",
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
        pflegegrad: (customer.pflegegrad ?? 0).toString(),
        primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
        backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
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
      email: formData.email.trim() || null,
      telefon: formData.telefon.trim() ? normalizePhone(formData.telefon) : null,
      festnetz: formData.festnetz.trim() ? normalizePhone(formData.festnetz) : null,
      strasse: formData.strasse.trim() || null,
      nr: formData.nr.trim() || null,
      plz: formData.plz.trim() || null,
      stadt: formData.stadt.trim() || null,
      primaryEmployeeId: primaryId,
      backupEmployeeId: backupId,
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
                <div className="grid grid-cols-4 gap-4">
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="strasse">Straße</Label>
                    <Input
                      id="strasse"
                      value={formData.strasse}
                      onChange={(e) => handleChange("strasse", e.target.value)}
                      placeholder="Musterstraße"
                      data-testid="input-strasse"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nr">Nr.</Label>
                    <Input
                      id="nr"
                      value={formData.nr}
                      onChange={(e) => handleChange("nr", e.target.value)}
                      placeholder="12a"
                      data-testid="input-nr"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="plz">PLZ</Label>
                    <Input
                      id="plz"
                      value={formData.plz}
                      onChange={(e) => handleChange("plz", e.target.value)}
                      placeholder="12345"
                      maxLength={5}
                      data-testid="input-plz"
                    />
                  </div>
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="stadt">Stadt</Label>
                    <Input
                      id="stadt"
                      value={formData.stadt}
                      onChange={(e) => handleChange("stadt", e.target.value)}
                      placeholder="Berlin"
                      data-testid="input-stadt"
                    />
                  </div>
                </div>
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
