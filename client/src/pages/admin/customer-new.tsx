import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { useEmployees, useInsuranceProviders, useCreateInsuranceProvider, useCreateCustomer } from "@/features/customers";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  User2,
  MapPin,
  Phone,
  Heart,
  Users,
  Wallet,
  FileText,
  Check,
  Plus,
  X,
} from "lucide-react";
import { iconSize, getPflegegradColors, componentStyles } from "@/design-system";

const STEPS = [
  { id: "personal", title: "Persönliche Daten", icon: User2 },
  { id: "insurance", title: "Pflegekasse", icon: Heart },
  { id: "contacts", title: "Kontakte", icon: Users },
  { id: "budgets", title: "Budgets", icon: Wallet },
  { id: "contract", title: "Vertrag", icon: FileText },
];

const PFLEGEGRAD_OPTIONS = [
  { value: "0", label: "Ohne Pflegegrad" },
  { value: "1", label: "Pflegegrad 1" },
  { value: "2", label: "Pflegegrad 2" },
  { value: "3", label: "Pflegegrad 3" },
  { value: "4", label: "Pflegegrad 4" },
  { value: "5", label: "Pflegegrad 5" },
];

const CONTACT_TYPES = [
  { value: "familie", label: "Familienmitglied" },
  { value: "angehoerige", label: "Angehörige" },
  { value: "nachbar", label: "Nachbar/in" },
  { value: "hausarzt", label: "Hausarzt" },
  { value: "betreuer", label: "Betreuer/in" },
  { value: "sonstige", label: "Sonstige" },
];

const PERIOD_TYPES = [
  { value: "weekly", label: "Pro Woche" },
  { value: "monthly", label: "Pro Monat" },
];

const DEFAULT_BUDGETS = {
  entlastungsbetrag45b: 125,
  verhinderungspflege39: 1612,
  pflegesachleistungen36: 0,
};

const BUDGET_AMOUNTS_BY_PFLEGEGRAD: Record<number, { pflegesachleistungen36: number }> = {
  0: { pflegesachleistungen36: 0 },
  1: { pflegesachleistungen36: 0 },
  2: { pflegesachleistungen36: 761 },
  3: { pflegesachleistungen36: 1432 },
  4: { pflegesachleistungen36: 1778 },
  5: { pflegesachleistungen36: 2200 },
};

export default function AdminCustomerNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);

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
    pflegegrad: "0",
    pflegegradSeit: "",
    primaryEmployeeId: "",
    backupEmployeeId: "",
    insuranceProviderId: "",
    versichertennummer: "",
    contactVorname: "",
    contactNachname: "",
    contactType: "familie",
    contactTelefon: "",
    contactEmail: "",
    contactIsPrimary: true,
    entlastungsbetrag45b: DEFAULT_BUDGETS.entlastungsbetrag45b.toString(),
    verhinderungspflege39: DEFAULT_BUDGETS.verhinderungspflege39.toString(),
    pflegesachleistungen36: DEFAULT_BUDGETS.pflegesachleistungen36.toString(),
    contractHours: "10",
    contractPeriod: "weekly" as "weekly" | "monthly",
    hauswirtschaftRate: "38",
    alltagsbegleitungRate: "42",
    kilometerRate: "0.35",
  });

  const { data: insuranceProviders } = useInsuranceProviders();
  const { data: employees } = useEmployees();
  const createMutation = useCreateCustomer();
  const createProviderMutation = useCreateInsuranceProvider();

  const [showNewProviderForm, setShowNewProviderForm] = useState(false);
  const [phoneErrors, setPhoneErrors] = useState<Record<string, string | null>>({});
  const [newProvider, setNewProvider] = useState({
    name: "",
    ikNummer: "",
    strasse: "",
    hausnummer: "",
    plz: "",
    stadt: "",
    telefon: "",
    email: "",
  });

  const handleNewProviderChange = (field: string, value: string) => {
    setNewProvider((prev) => ({ ...prev, [field]: value }));
  };

  const handleCreateProvider = () => {
    if (!newProvider.name.trim() || !newProvider.ikNummer.trim()) {
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Name und IK-Nummer sind erforderlich.",
        variant: "destructive",
      });
      return;
    }

    if (!/^\d{9}$/.test(newProvider.ikNummer)) {
      toast({
        title: "Ungültige IK-Nummer",
        description: "Die IK-Nummer muss genau 9 Ziffern enthalten.",
        variant: "destructive",
      });
      return;
    }

    createProviderMutation.mutate(
      {
        name: newProvider.name.trim(),
        ikNummer: newProvider.ikNummer.trim(),
        strasse: newProvider.strasse.trim() || undefined,
        hausnummer: newProvider.hausnummer.trim() || undefined,
        plz: newProvider.plz.trim() || undefined,
        stadt: newProvider.stadt.trim() || undefined,
        telefon: newProvider.telefon.trim() || undefined,
        email: newProvider.email.trim() || undefined,
      },
      {
        onSuccess: (provider) => {
          toast({ title: "Pflegekasse erfolgreich erstellt" });
          setFormData((prev) => ({ ...prev, insuranceProviderId: provider.id.toString() }));
          setShowNewProviderForm(false);
          setNewProvider({
            name: "",
            ikNummer: "",
            strasse: "",
            hausnummer: "",
            plz: "",
            stadt: "",
            telefon: "",
            email: "",
          });
        },
        onError: (error: Error) => {
          toast({
            title: "Fehler",
            description: error.message,
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleCreate = () => {
    const today = new Date().toISOString().split("T")[0];
    
    // Validate phone numbers before submission
    const phoneValidationErrors: string[] = [];
    if (formData.telefon.trim()) {
      const result = validateGermanPhone(formData.telefon);
      if (!result.valid) phoneValidationErrors.push(`Mobiltelefon: ${result.error}`);
    }
    if (formData.festnetz.trim()) {
      const result = validateGermanPhone(formData.festnetz);
      if (!result.valid) phoneValidationErrors.push(`Festnetz: ${result.error}`);
    }
    if (formData.contactTelefon.trim()) {
      const result = validateGermanPhone(formData.contactTelefon);
      if (!result.valid) phoneValidationErrors.push(`Kontakt-Telefon: ${result.error}`);
    }
    
    if (phoneValidationErrors.length > 0) {
      toast({
        title: "Ungültige Telefonnummern",
        description: phoneValidationErrors.join("; "),
        variant: "destructive",
      });
      return;
    }
    
    // Build optional sections
    const insurance = formData.insuranceProviderId && formData.versichertennummer.trim() 
      ? {
          providerId: parseInt(formData.insuranceProviderId),
          versichertennummer: formData.versichertennummer.trim(),
          validFrom: today,
        } 
      : undefined;

    const contactPhone = formData.contactTelefon.trim() ? (normalizePhone(formData.contactTelefon) || "") : "";
    const contacts = formData.contactVorname.trim() && formData.contactNachname.trim() && contactPhone
      ? [{
          contactType: formData.contactType,
          isPrimary: formData.contactIsPrimary,
          vorname: formData.contactVorname.trim(),
          nachname: formData.contactNachname.trim(),
          telefon: contactPhone,
          email: formData.contactEmail.trim() || undefined,
        }]
      : undefined;

    const budgetValues = {
      entlastungsbetrag45b: Math.round(parseFloat(formData.entlastungsbetrag45b) * 100) || 0,
      verhinderungspflege39: Math.round(parseFloat(formData.verhinderungspflege39) * 100) || 0,
      pflegesachleistungen36: Math.round(parseFloat(formData.pflegesachleistungen36) * 100) || 0,
      validFrom: today,
    };
    const budgets = budgetValues.entlastungsbetrag45b > 0 || budgetValues.verhinderungspflege39 > 0 || budgetValues.pflegesachleistungen36 > 0
      ? budgetValues
      : undefined;

    const contractHours = parseFloat(formData.contractHours);
    const rates = [
      { serviceCategory: "hauswirtschaft", hourlyRateCents: Math.round(parseFloat(formData.hauswirtschaftRate) * 100) || 0 },
      { serviceCategory: "alltagsbegleitung", hourlyRateCents: Math.round(parseFloat(formData.alltagsbegleitungRate) * 100) || 0 },
      { serviceCategory: "erstberatung", hourlyRateCents: Math.round(parseFloat(formData.erstberatungRate) * 100) || 0 },
    ].filter(r => r.hourlyRateCents > 0);
    const contract = contractHours > 0 && rates.length > 0
      ? {
          contractStart: today,
          hoursPerPeriod: contractHours,
          periodType: formData.contractPeriod,
          rates,
        }
      : undefined;

    const payload = {
      vorname: formData.vorname.trim(),
      nachname: formData.nachname.trim(),
      strasse: formData.strasse.trim(),
      nr: formData.nr.trim(),
      plz: formData.plz.trim(),
      stadt: formData.stadt.trim(),
      pflegegrad: parseInt(formData.pflegegrad),
      pflegegradSeit: formData.pflegegradSeit || today,
      email: formData.email.trim() || undefined,
      telefon: formData.telefon.trim() ? (normalizePhone(formData.telefon) || undefined) : undefined,
      festnetz: formData.festnetz.trim() ? (normalizePhone(formData.festnetz) || undefined) : undefined,
      insurance,
      contacts,
      budgets,
      contract,
    };

    createMutation.mutate(payload, {
      onSuccess: (customer) => {
        toast({ title: "Kunde erfolgreich erstellt" });
        setLocation(`/admin/customers/${customer.id}`);
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  };

  const phoneFields = ["telefon", "festnetz", "contactTelefon"] as const;
  
  const handleChange = (field: string, value: string | boolean) => {
    if ((phoneFields as readonly string[]).includes(field) && typeof value === "string") {
      const formatted = formatPhoneAsYouType(value);
      setFormData((prev) => ({ ...prev, [field]: formatted }));
      if (value.trim()) {
        const validation = validateGermanPhone(value);
        setPhoneErrors((prev) => ({ ...prev, [field]: validation.valid ? null : validation.error || "Ungültige Telefonnummer" }));
      } else {
        setPhoneErrors((prev) => ({ ...prev, [field]: null }));
      }
      return;
    }
    
    setFormData((prev) => {
      const newData = { ...prev, [field]: value };
      if (field === "pflegegrad") {
        const pg = parseInt(value as string);
        const amounts = BUDGET_AMOUNTS_BY_PFLEGEGRAD[pg] || { pflegesachleistungen36: 0 };
        newData.pflegesachleistungen36 = amounts.pflegesachleistungen36.toString();
      }
      return newData;
    });
  };

  const validateStep = (step: number): boolean => {
    switch (step) {
      case 0:
        return !!(formData.vorname && formData.nachname && formData.strasse && formData.nr && formData.plz && formData.stadt);
      case 1:
        if (formData.insuranceProviderId) {
          return !!formData.versichertennummer;
        }
        return true;
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      if (currentStep < STEPS.length - 1) {
        setCurrentStep(currentStep + 1);
      }
    } else {
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Bitte füllen Sie alle markierten Felder aus.",
        variant: "destructive",
      });
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = () => {
    if (!validateStep(0)) {
      setCurrentStep(0);
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Bitte füllen Sie die persönlichen Daten vollständig aus.",
        variant: "destructive",
      });
      return;
    }
    handleCreate();
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vorname">Vorname *</Label>
                <Input
                  id="vorname"
                  value={formData.vorname}
                  onChange={(e) => handleChange("vorname", e.target.value)}
                  required
                  data-testid="input-vorname"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="nachname">Nachname *</Label>
                <Input
                  id="nachname"
                  value={formData.nachname}
                  onChange={(e) => handleChange("nachname", e.target.value)}
                  required
                  data-testid="input-nachname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">E-Mail</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => handleChange("email", e.target.value)}
                data-testid="input-email"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="telefon">Mobiltelefon</Label>
                <Input
                  id="telefon"
                  value={formData.telefon}
                  onChange={(e) => handleChange("telefon", e.target.value)}
                  placeholder="0170 1234567"
                  className={phoneErrors.telefon ? "border-red-500" : ""}
                  data-testid="input-telefon"
                />
                {phoneErrors.telefon && (
                  <p className="text-xs text-red-500">{phoneErrors.telefon}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="festnetz">Festnetz</Label>
                <Input
                  id="festnetz"
                  value={formData.festnetz}
                  onChange={(e) => handleChange("festnetz", e.target.value)}
                  placeholder="030 1234567"
                  className={phoneErrors.festnetz ? "border-red-500" : ""}
                  data-testid="input-festnetz"
                />
                {phoneErrors.festnetz && (
                  <p className="text-xs text-red-500">{phoneErrors.festnetz}</p>
                )}
              </div>
            </div>

            <div className="border-t pt-4">
              <h3 className="font-medium mb-4 flex items-center gap-2">
                <MapPin className={iconSize.sm} />
                Adresse
              </h3>
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-4">
                  <div className="col-span-3 space-y-2">
                    <Label htmlFor="strasse">Straße *</Label>
                    <Input
                      id="strasse"
                      value={formData.strasse}
                      onChange={(e) => handleChange("strasse", e.target.value)}
                      required
                      data-testid="input-strasse"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nr">Nr. *</Label>
                    <Input
                      id="nr"
                      value={formData.nr}
                      onChange={(e) => handleChange("nr", e.target.value)}
                      required
                      data-testid="input-nr"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="plz">PLZ *</Label>
                    <Input
                      id="plz"
                      value={formData.plz}
                      onChange={(e) => handleChange("plz", e.target.value)}
                      maxLength={5}
                      required
                      data-testid="input-plz"
                    />
                  </div>
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="stadt">Stadt *</Label>
                    <Input
                      id="stadt"
                      value={formData.stadt}
                      onChange={(e) => handleChange("stadt", e.target.value)}
                      required
                      data-testid="input-stadt"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="pflegegrad">Pflegegrad</Label>
                  <Select
                    value={formData.pflegegrad}
                    onValueChange={(value) => handleChange("pflegegrad", value)}
                  >
                    <SelectTrigger data-testid="select-pflegegrad">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PFLEGEGRAD_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Pflegegrad seit</Label>
                  <DatePicker
                    value={formData.pflegegradSeit || null}
                    onChange={(val) => handleChange("pflegegradSeit", val || "")}
                    data-testid="input-pflegegrad-seit"
                  />
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <h3 className="font-medium mb-4">Zuständige Mitarbeiter</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="primaryEmployeeId">Hauptansprechpartner</Label>
                  <Select
                    value={formData.primaryEmployeeId}
                    onValueChange={(value) => handleChange("primaryEmployeeId", value)}
                  >
                    <SelectTrigger data-testid="select-primary-employee">
                      <SelectValue placeholder="Auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {employees?.map((emp) => (
                        <SelectItem key={emp.id} value={emp.id.toString()}>
                          {emp.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="backupEmployeeId">Vertretung</Label>
                  <Select
                    value={formData.backupEmployeeId}
                    onValueChange={(value) => handleChange("backupEmployeeId", value)}
                  >
                    <SelectTrigger data-testid="select-backup-employee">
                      <SelectValue placeholder="Auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {employees?.map((emp) => (
                        <SelectItem key={emp.id} value={emp.id.toString()}>
                          {emp.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>
        );

      case 1:
        return (
          <div className="space-y-6">
            {!showNewProviderForm ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="insuranceProviderId">Pflegekasse</Label>
                  <div className="flex gap-2">
                    <Select
                      value={formData.insuranceProviderId}
                      onValueChange={(value) => handleChange("insuranceProviderId", value)}
                    >
                      <SelectTrigger data-testid="select-insurance-provider" className="flex-1">
                        <SelectValue placeholder="Pflegekasse auswählen..." />
                      </SelectTrigger>
                      <SelectContent>
                        {insuranceProviders?.map((provider) => (
                          <SelectItem key={provider.id} value={provider.id.toString()}>
                            {provider.name} (IK: {provider.ikNummer})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowNewProviderForm(true)}
                      data-testid="button-add-new-provider"
                    >
                      <Plus className={`${iconSize.sm} mr-1`} />
                      Neu
                    </Button>
                  </div>
                </div>

                {formData.insuranceProviderId && (
                  <div className="space-y-2">
                    <Label htmlFor="versichertennummer">Versichertennummer *</Label>
                    <Input
                      id="versichertennummer"
                      value={formData.versichertennummer}
                      onChange={(e) => handleChange("versichertennummer", e.target.value.toUpperCase())}
                      placeholder="A123456789"
                      maxLength={10}
                      required
                      data-testid="input-versichertennummer"
                    />
                    <p className="text-xs text-gray-500">
                      Format: Buchstabe + 9 Ziffern (z.B. A123456789)
                    </p>
                  </div>
                )}

                {!insuranceProviders?.length && !showNewProviderForm && (
                  <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
                    <p className="text-amber-800 text-sm">
                      Es sind noch keine Pflegekassen im System hinterlegt.{" "}
                      <button
                        type="button"
                        onClick={() => setShowNewProviderForm(true)}
                        className="font-medium underline hover:text-amber-900"
                        data-testid="link-add-first-provider"
                      >
                        Neue Pflegekasse hinzufügen
                      </button>
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="p-4 rounded-lg border border-teal-200 bg-teal-50">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-medium text-teal-900">Neue Pflegekasse anlegen</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowNewProviderForm(false)}
                    data-testid="button-cancel-new-provider"
                  >
                    <X className={iconSize.sm} />
                  </Button>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="newProviderName">Name der Pflegekasse *</Label>
                      <Input
                        id="newProviderName"
                        value={newProvider.name}
                        onChange={(e) => handleNewProviderChange("name", e.target.value)}
                        placeholder="z.B. AOK Bayern"
                        data-testid="input-new-provider-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newProviderIk">IK-Nummer *</Label>
                      <Input
                        id="newProviderIk"
                        value={newProvider.ikNummer}
                        onChange={(e) => handleNewProviderChange("ikNummer", e.target.value.replace(/\D/g, ""))}
                        placeholder="123456789"
                        maxLength={9}
                        data-testid="input-new-provider-ik"
                      />
                      <p className="text-xs text-gray-500">9-stellige Institutionskennzeichen</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newProviderTelefon">Telefon</Label>
                      <Input
                        id="newProviderTelefon"
                        value={newProvider.telefon}
                        onChange={(e) => handleNewProviderChange("telefon", e.target.value)}
                        placeholder="+49 89 1234567"
                        data-testid="input-new-provider-telefon"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="newProviderEmail">E-Mail</Label>
                    <Input
                      id="newProviderEmail"
                      type="email"
                      value={newProvider.email}
                      onChange={(e) => handleNewProviderChange("email", e.target.value)}
                      placeholder="kontakt@pflegekasse.de"
                      data-testid="input-new-provider-email"
                    />
                  </div>

                  <div className="border-t border-teal-200 pt-4">
                    <p className="text-xs text-gray-500 mb-2">Adresse (optional)</p>
                    <div className="grid grid-cols-4 gap-4">
                      <div className="col-span-3 space-y-2">
                        <Label htmlFor="newProviderStrasse">Straße</Label>
                        <Input
                          id="newProviderStrasse"
                          value={newProvider.strasse}
                          onChange={(e) => handleNewProviderChange("strasse", e.target.value)}
                          data-testid="input-new-provider-strasse"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="newProviderHausnummer">Nr.</Label>
                        <Input
                          id="newProviderHausnummer"
                          value={newProvider.hausnummer}
                          onChange={(e) => handleNewProviderChange("hausnummer", e.target.value)}
                          data-testid="input-new-provider-hausnummer"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mt-2">
                      <div className="space-y-2">
                        <Label htmlFor="newProviderPlz">PLZ</Label>
                        <Input
                          id="newProviderPlz"
                          value={newProvider.plz}
                          onChange={(e) => handleNewProviderChange("plz", e.target.value)}
                          maxLength={5}
                          data-testid="input-new-provider-plz"
                        />
                      </div>
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="newProviderStadt">Stadt</Label>
                        <Input
                          id="newProviderStadt"
                          value={newProvider.stadt}
                          onChange={(e) => handleNewProviderChange("stadt", e.target.value)}
                          data-testid="input-new-provider-stadt"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowNewProviderForm(false)}
                      data-testid="button-cancel-provider-form"
                    >
                      Abbrechen
                    </Button>
                    <Button
                      type="button"
                      className="bg-teal-600 hover:bg-teal-700"
                      onClick={handleCreateProvider}
                      disabled={createProviderMutation.isPending}
                      data-testid="button-save-new-provider"
                    >
                      {createProviderMutation.isPending ? (
                        <>
                          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                          Speichern...
                        </>
                      ) : (
                        <>
                          <Check className={`${iconSize.sm} mr-2`} />
                          Pflegekasse speichern
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            <p className="text-sm text-gray-600">
              Fügen Sie einen Notfallkontakt hinzu. Weitere Kontakte können Sie später ergänzen.
            </p>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactVorname">Vorname</Label>
                  <Input
                    id="contactVorname"
                    value={formData.contactVorname}
                    onChange={(e) => handleChange("contactVorname", e.target.value)}
                    data-testid="input-contact-vorname"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactNachname">Nachname</Label>
                  <Input
                    id="contactNachname"
                    value={formData.contactNachname}
                    onChange={(e) => handleChange("contactNachname", e.target.value)}
                    data-testid="input-contact-nachname"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactType">Kontaktart</Label>
                  <Select
                    value={formData.contactType}
                    onValueChange={(value) => handleChange("contactType", value)}
                  >
                    <SelectTrigger data-testid="select-contact-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contactTelefon">Telefon</Label>
                  <Input
                    id="contactTelefon"
                    value={formData.contactTelefon}
                    onChange={(e) => handleChange("contactTelefon", e.target.value)}
                    placeholder="0170 1234567"
                    className={phoneErrors.contactTelefon ? "border-red-500" : ""}
                    data-testid="input-contact-telefon"
                  />
                  {phoneErrors.contactTelefon && (
                    <p className="text-xs text-red-500">{phoneErrors.contactTelefon}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="contactEmail">E-Mail (optional)</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  value={formData.contactEmail}
                  onChange={(e) => handleChange("contactEmail", e.target.value)}
                  data-testid="input-contact-email"
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="contactIsPrimary"
                  checked={formData.contactIsPrimary}
                  onCheckedChange={(checked) => handleChange("contactIsPrimary", !!checked)}
                  data-testid="checkbox-contact-primary"
                />
                <Label htmlFor="contactIsPrimary">Hauptkontakt</Label>
              </div>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            <p className="text-sm text-gray-600">
              Erfassen Sie die monatlichen Leistungsansprüche des Kunden.
            </p>

            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-green-50 border border-green-100">
                <div className="space-y-2">
                  <Label htmlFor="entlastungsbetrag45b">§45b Entlastungsbetrag (€/Monat)</Label>
                  <Input
                    id="entlastungsbetrag45b"
                    type="number"
                    step="0.01"
                    value={formData.entlastungsbetrag45b}
                    onChange={(e) => handleChange("entlastungsbetrag45b", e.target.value)}
                    data-testid="input-budget-45b"
                  />
                  <p className="text-xs text-gray-500">Standard: 125 €/Monat</p>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-blue-50 border border-blue-100">
                <div className="space-y-2">
                  <Label htmlFor="verhinderungspflege39">§39 Verhinderungspflege (€/Jahr)</Label>
                  <Input
                    id="verhinderungspflege39"
                    type="number"
                    step="0.01"
                    value={formData.verhinderungspflege39}
                    onChange={(e) => handleChange("verhinderungspflege39", e.target.value)}
                    data-testid="input-budget-39"
                  />
                  <p className="text-xs text-gray-500">Standard: 1.612 €/Jahr</p>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-purple-50 border border-purple-100">
                <div className="space-y-2">
                  <Label htmlFor="pflegesachleistungen36">§36 Pflegesachleistungen (€/Monat)</Label>
                  <Input
                    id="pflegesachleistungen36"
                    type="number"
                    step="0.01"
                    value={formData.pflegesachleistungen36}
                    onChange={(e) => handleChange("pflegesachleistungen36", e.target.value)}
                    data-testid="input-budget-36"
                  />
                  <p className="text-xs text-gray-500">
                    Abhängig vom Pflegegrad (PG2: 761€, PG3: 1.432€, PG4: 1.778€, PG5: 2.200€)
                  </p>
                </div>
              </div>
            </div>
          </div>
        );

      case 4:
        return (
          <div className="space-y-6">
            <p className="text-sm text-gray-600">
              Legen Sie die Vertragsbedingungen und Stundensätze fest.
            </p>

            <div className="border-b pb-4">
              <h3 className="font-medium mb-4">Vereinbarte Leistungen</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contractHours">Stunden pro Zeitraum</Label>
                  <Input
                    id="contractHours"
                    type="number"
                    step="0.5"
                    value={formData.contractHours}
                    onChange={(e) => handleChange("contractHours", e.target.value)}
                    data-testid="input-contract-hours"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contractPeriod">Zeitraum</Label>
                  <Select
                    value={formData.contractPeriod}
                    onValueChange={(value) => handleChange("contractPeriod", value)}
                  >
                    <SelectTrigger data-testid="select-contract-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERIOD_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-4">Stundensätze</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="hauswirtschaftRate">Hauswirtschaft (€/Std)</Label>
                  <Input
                    id="hauswirtschaftRate"
                    type="number"
                    step="0.01"
                    value={formData.hauswirtschaftRate}
                    onChange={(e) => handleChange("hauswirtschaftRate", e.target.value)}
                    data-testid="input-rate-hauswirtschaft"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="alltagsbegleitungRate">Alltagsbegleitung (€/Std)</Label>
                  <Input
                    id="alltagsbegleitungRate"
                    type="number"
                    step="0.01"
                    value={formData.alltagsbegleitungRate}
                    onChange={(e) => handleChange("alltagsbegleitungRate", e.target.value)}
                    data-testid="input-rate-alltagsbegleitung"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="erstberatungRate">Erstberatung (€/Std)</Label>
                  <Input
                    id="erstberatungRate"
                    type="number"
                    step="0.01"
                    value={formData.erstberatungRate}
                    onChange={(e) => handleChange("erstberatungRate", e.target.value)}
                    data-testid="input-rate-erstberatung"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Standardsätze: Hauswirtschaft 38€/Std, Alltagsbegleitung 42€/Std
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-3xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin/customers">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">Neuen Kunden anlegen</h1>
          </div>

          <div className="mb-8">
            <div className="flex items-center justify-between">
              {STEPS.map((step, index) => (
                <div
                  key={step.id}
                  className={`flex items-center ${index < STEPS.length - 1 ? "flex-1" : ""}`}
                >
                  <div
                    className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors ${
                      index < currentStep
                        ? "bg-teal-600 border-teal-600 text-white"
                        : index === currentStep
                        ? "border-teal-600 text-teal-600 bg-white"
                        : "border-gray-300 text-gray-400 bg-white"
                    }`}
                  >
                    {index < currentStep ? (
                      <Check className={iconSize.md} />
                    ) : (
                      <step.icon className={iconSize.md} />
                    )}
                  </div>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-2 ${
                        index < currentStep ? "bg-teal-600" : "bg-gray-300"
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2">
              {STEPS.map((step, index) => (
                <span
                  key={step.id}
                  className={`text-xs ${
                    index === currentStep ? "text-teal-700 font-medium" : "text-gray-500"
                  }`}
                  style={{ width: `${100 / STEPS.length}%`, textAlign: "center" }}
                >
                  {step.title}
                </span>
              ))}
            </div>
          </div>

          <Card className="bg-white">
            <CardContent className="p-6">
              {renderStepContent()}

              <div className="flex justify-between mt-8 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={handleBack}
                  disabled={currentStep === 0}
                  data-testid="button-step-back"
                >
                  <ChevronLeft className={`${iconSize.sm} mr-2`} />
                  Zurück
                </Button>

                {currentStep === STEPS.length - 1 ? (
                  <Button
                    className="bg-teal-600 hover:bg-teal-700"
                    onClick={handleSubmit}
                    disabled={createMutation.isPending}
                    data-testid="button-submit"
                  >
                    {createMutation.isPending ? (
                      <>
                        <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                        Erstellen...
                      </>
                    ) : (
                      <>
                        Kunde erstellen
                        <Check className={`${iconSize.sm} ml-2`} />
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    className="bg-teal-600 hover:bg-teal-700"
                    onClick={handleNext}
                    data-testid="button-step-next"
                  >
                    Weiter
                    <ChevronRight className={`${iconSize.sm} ml-2`} />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
