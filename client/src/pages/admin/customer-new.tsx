import { useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { useEmployees, useInsuranceProviders, useCreateCustomer } from "@/features/customers";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO } from "@shared/utils/datetime";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { CustomerFormData, ContactFormData, STEPS, DEFAULT_BUDGETS, EMPTY_CONTACT, MAX_CONTACTS } from "./components/customer-types";
import { BUDGET_45A_MAX_BY_PFLEGEGRAD } from "@shared/domain/budgets";
import { PersonalDataStep } from "./components/personal-data-step";
import { InsuranceStep } from "./components/insurance-step";
import { ContactsStep } from "./components/contacts-step";
import { BudgetsStep, ContractStep } from "./components/budgets-contract-step";

export default function AdminCustomerNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);

  const [formData, setFormData] = useState<CustomerFormData>({
    vorname: "",
    nachname: "",
    geburtsdatum: "",
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
    vorerkrankungen: "",
    haustierVorhanden: false,
    haustierDetails: "",
    personenbefoerderungGewuenscht: false,
    insuranceProviderId: "",
    versichertennummer: "",
    contacts: [{ ...EMPTY_CONTACT }],
    entlastungsbetrag45b: DEFAULT_BUDGETS.entlastungsbetrag45b.toString(),
    verhinderungspflege39: DEFAULT_BUDGETS.verhinderungspflege39.toString(),
    pflegesachleistungen36: DEFAULT_BUDGETS.pflegesachleistungen36.toString(),
    contractDate: "",
    contractStart: "",
    vereinbarteLeistungen: "",
    contractHours: "0",
    contractPeriod: "weekly",
  });

  const { data: insuranceProviders } = useInsuranceProviders();
  const { data: employees } = useEmployees();
  const createMutation = useCreateCustomer();

  const employeeOptions = useMemo(() =>
    employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || [],
    [employees]
  );

  const insuranceOptions = useMemo(() =>
    insuranceProviders?.map((p) => ({
      value: p.id.toString(),
      label: p.name,
      sublabel: `IK: ${p.ikNummer}`,
    })) || [],
    [insuranceProviders]
  );

  const [phoneErrors, setPhoneErrors] = useState<Record<string, string | null>>({});

  const handleContactChange = useCallback((index: number, field: keyof ContactFormData, value: string | boolean) => {
    if (field === "telefon" && typeof value === "string") {
      const formatted = formatPhoneAsYouType(value);
      setFormData((prev) => {
        const newContacts = [...prev.contacts];
        newContacts[index] = { ...newContacts[index], telefon: formatted };
        return { ...prev, contacts: newContacts };
      });
      if (value.trim()) {
        const validation = validateGermanPhone(value);
        setPhoneErrors((prev) => ({ ...prev, [`contact_${index}`]: validation.valid ? null : validation.error || "Ungültige Telefonnummer" }));
      } else {
        setPhoneErrors((prev) => ({ ...prev, [`contact_${index}`]: null }));
      }
      return;
    }

    setFormData((prev) => {
      const newContacts = [...prev.contacts];
      newContacts[index] = { ...newContacts[index], [field]: value };
      if (field === "isPrimary" && value === true) {
        newContacts.forEach((c, i) => {
          if (i !== index) newContacts[i] = { ...c, isPrimary: false };
        });
      }
      return { ...prev, contacts: newContacts };
    });
  }, []);

  const handleAddContact = useCallback(() => {
    setFormData((prev) => {
      if (prev.contacts.length >= MAX_CONTACTS) return prev;
      return { ...prev, contacts: [...prev.contacts, { ...EMPTY_CONTACT, isPrimary: false }] };
    });
  }, []);

  const handleRemoveContact = useCallback((index: number) => {
    setFormData((prev) => {
      const newContacts = prev.contacts.filter((_, i) => i !== index);
      if (newContacts.length > 0 && !newContacts.some(c => c.isPrimary)) {
        newContacts[0] = { ...newContacts[0], isPrimary: true };
      }
      return { ...prev, contacts: newContacts };
    });
    setPhoneErrors((prev) => {
      const next = { ...prev };
      delete next[`contact_${index}`];
      return next;
    });
  }, []);

  const handleCreate = () => {
    const today = todayISO();
    
    const phoneValidationErrors: string[] = [];
    if (formData.telefon.trim()) {
      const result = validateGermanPhone(formData.telefon);
      if (!result.valid) phoneValidationErrors.push(`Mobiltelefon: ${result.error}`);
    }
    if (formData.festnetz.trim()) {
      const result = validateGermanPhone(formData.festnetz);
      if (!result.valid) phoneValidationErrors.push(`Festnetz: ${result.error}`);
    }
    formData.contacts.forEach((contact, index) => {
      if (contact.telefon.trim()) {
        const result = validateGermanPhone(contact.telefon);
        if (!result.valid) phoneValidationErrors.push(`Kontakt ${index + 1} Telefon: ${result.error}`);
      }
    });
    
    if (phoneValidationErrors.length > 0) {
      toast({
        title: "Ungültige Telefonnummern",
        description: phoneValidationErrors.join("; "),
        variant: "destructive",
      });
      return;
    }
    
    const insurance = formData.insuranceProviderId && formData.versichertennummer.trim() 
      ? {
          providerId: parseInt(formData.insuranceProviderId),
          versichertennummer: formData.versichertennummer.trim(),
          validFrom: today,
        } 
      : undefined;

    const contacts = formData.contacts
      .filter(c => c.vorname.trim() && c.nachname.trim())
      .map(c => ({
        contactType: c.contactType,
        isPrimary: c.isPrimary,
        vorname: c.vorname.trim(),
        nachname: c.nachname.trim(),
        telefon: c.telefon.trim() ? (normalizePhone(c.telefon) || c.telefon.trim()) : "",
        email: c.email.trim() || undefined,
      }));

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
    const contract = contractHours > 0 || formData.vereinbarteLeistungen.trim() || formData.contractDate
      ? {
          contractStart: formData.contractStart || today,
          contractDate: formData.contractDate || undefined,
          vereinbarteLeistungen: formData.vereinbarteLeistungen.trim() || undefined,
          hoursPerPeriod: contractHours || 0,
          periodType: formData.contractPeriod === "weekly" ? "week" : "month",
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
      geburtsdatum: formData.geburtsdatum || undefined,
      email: formData.email.trim() || undefined,
      telefon: formData.telefon.trim() ? (normalizePhone(formData.telefon) || undefined) : undefined,
      festnetz: formData.festnetz.trim() ? (normalizePhone(formData.festnetz) || undefined) : undefined,
      vorerkrankungen: formData.vorerkrankungen.trim() || undefined,
      haustierVorhanden: formData.haustierVorhanden,
      haustierDetails: formData.haustierVorhanden ? (formData.haustierDetails.trim() || undefined) : undefined,
      personenbefoerderungGewuenscht: formData.personenbefoerderungGewuenscht,
      insurance,
      contacts: contacts.length > 0 ? contacts : undefined,
      budgets,
      contract,
    };

    createMutation.mutate(payload, {
      onSuccess: async (customer) => {
        const primaryId = formData.primaryEmployeeId ? parseInt(formData.primaryEmployeeId) : null;
        const backupId = formData.backupEmployeeId ? parseInt(formData.backupEmployeeId) : null;
        if (primaryId || backupId) {
          try {
            const { apiRequest } = await import("@/lib/queryClient");
            await apiRequest("PATCH", `/api/admin/customers/${customer.id}/assign`, {
              primaryEmployeeId: primaryId,
              backupEmployeeId: backupId,
            });
          } catch {
          }
        }
        toast({ title: "Kunde erfolgreich erstellt" });
        setLocation(`/admin/customers/${customer.id}`);
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  };

  const personalPhoneFields = ["telefon", "festnetz"] as const;
  
  const handleChange = (field: string, value: string | boolean) => {
    if ((personalPhoneFields as readonly string[]).includes(field) && typeof value === "string") {
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
        const maxCents = BUDGET_45A_MAX_BY_PFLEGEGRAD[pg] ?? 0;
        newData.pflegesachleistungen36 = (maxCents / 100).toString();
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
          <PersonalDataStep
            formData={formData}
            phoneErrors={phoneErrors}
            employeeOptions={employeeOptions}
            onChange={handleChange}
          />
        );
      case 1:
        return (
          <InsuranceStep
            formData={formData}
            insuranceOptions={insuranceOptions}
            insuranceProvidersEmpty={!insuranceProviders?.length}
            onChange={handleChange}
            onInsuranceProviderCreated={(providerId) =>
              setFormData((prev) => ({ ...prev, insuranceProviderId: providerId }))
            }
          />
        );
      case 2:
        return (
          <ContactsStep
            contacts={formData.contacts}
            phoneErrors={phoneErrors}
            onContactChange={handleContactChange}
            onAddContact={handleAddContact}
            onRemoveContact={handleRemoveContact}
          />
        );
      case 3:
        return (
          <BudgetsStep
            formData={formData}
            onChange={handleChange}
            pflegegrad={formData.pflegegrad ? parseInt(formData.pflegegrad) : null}
          />
        );
      case 4:
        return (
          <ContractStep
            formData={formData}
            onChange={handleChange}
          />
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
