import { useState, useMemo, useCallback, useRef } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { useInsuranceProviders, useCreateCustomer } from "@/features/customers";
import { api } from "@/lib/api";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO } from "@shared/utils/datetime";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { CustomerFormData, ContactFormData, BudgetTypeSettingForm, getStepsForBillingType, DEFAULT_BUDGETS, EMPTY_CONTACT, MAX_CONTACTS } from "./components/customer-types";
import { BUDGET_45A_MAX_BY_PFLEGEGRAD, BUDGET_TYPES, type BudgetType } from "@shared/domain/budgets";
import { isPflegekasseCustomer, type BillingType } from "@shared/domain/customers";
import { CustomerTypeStep } from "./components/customer-type-step";
import { PersonalDataStep } from "./components/personal-data-step";
import { InsuranceStep } from "./components/insurance-step";
import { ContactsStep } from "./components/contacts-step";
import { BudgetsStep, ContractStep } from "./components/budgets-contract-step";
import { SignaturesStep, type WizardUploadedDoc } from "./components/signatures-step";
import { MatchingStep } from "./components/matching-step";
import { DeliveryStep } from "./components/delivery-step";

export default function AdminCustomerNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);

  const [formData, setFormData] = useState<CustomerFormData>({
    billingType: "" as any,
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
    budgetTypeSettings: BUDGET_TYPES.map((bt) => ({
      budgetType: bt,
      enabled: bt === "entlastungsbetrag_45b",
      monthlyLimitCents: "",
      yearlyLimitCents: "",
    })),
    entlastungsbetrag45b: DEFAULT_BUDGETS.entlastungsbetrag45b.toString(),
    verhinderungspflege39: DEFAULT_BUDGETS.verhinderungspflege39.toString(),
    pflegesachleistungen36: DEFAULT_BUDGETS.pflegesachleistungen36.toString(),
    contractDate: todayISO(),
    contractStart: todayISO(),
    vereinbarteLeistungen: "",
    contractHours: "0",
    contractPeriod: "weekly",
    documentDeliveryMethod: "email",
  });

  const [customerSignatures, setCustomerSignatures] = useState<Record<string, string>>({});
  const [uploadedDocuments, setUploadedDocuments] = useState<WizardUploadedDoc[]>([]);
  const signingLocationRef = useRef<string | null>(null);

  const handleSignatureChange = useCallback((slug: string, signatureData: string, location?: string | null) => {
    setCustomerSignatures((prev) => ({ ...prev, [slug]: signatureData }));
    if (location) {
      signingLocationRef.current = location;
    }
  }, []);

  const steps = useMemo(() => getStepsForBillingType(formData.billingType), [formData.billingType]);
  const currentStepId = steps[currentStep]?.id || "customerType";

  const goToStep = useCallback((step: number) => {
    setCurrentStep(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const { data: insuranceProviders } = useInsuranceProviders();
  const createMutation = useCreateCustomer();

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

    const isPflegekasse = isPflegekasseCustomer(formData.billingType);

    const payload = {
      billingType: formData.billingType,
      vorname: formData.vorname.trim(),
      nachname: formData.nachname.trim(),
      strasse: formData.strasse.trim(),
      nr: formData.nr.trim(),
      plz: formData.plz.trim(),
      stadt: formData.stadt.trim(),
      pflegegrad: isPflegekasse ? parseInt(formData.pflegegrad) : undefined,
      pflegegradSeit: isPflegekasse && formData.pflegegradSeit ? formData.pflegegradSeit : isPflegekasse ? today : undefined,
      geburtsdatum: formData.geburtsdatum || undefined,
      email: formData.email.trim() || undefined,
      telefon: formData.telefon.trim() ? (normalizePhone(formData.telefon) || undefined) : undefined,
      festnetz: formData.festnetz.trim() ? (normalizePhone(formData.festnetz) || undefined) : undefined,
      vorerkrankungen: isPflegekasse ? (formData.vorerkrankungen.trim() || undefined) : undefined,
      haustierVorhanden: formData.haustierVorhanden,
      haustierDetails: formData.haustierVorhanden ? (formData.haustierDetails.trim() || undefined) : undefined,
      personenbefoerderungGewuenscht: formData.personenbefoerderungGewuenscht,
      documentDeliveryMethod: formData.documentDeliveryMethod,
      insurance: isPflegekasse ? insurance : undefined,
      contacts: contacts.length > 0 ? contacts : undefined,
      budgets: isPflegekasse ? budgets : undefined,
      contract,
    };

    const warnings: string[] = [];
    createMutation.mutate(payload, {
      onSuccess: async (customer) => {
        const primaryId = formData.primaryEmployeeId ? parseInt(formData.primaryEmployeeId) : null;
        const backupId = formData.backupEmployeeId ? parseInt(formData.backupEmployeeId) : null;
        if (primaryId || backupId) {
          try {
            await api.patch(`/admin/customers/${customer.id}/assign`, {
              primaryEmployeeId: primaryId,
              backupEmployeeId: backupId,
            });
          } catch (assignError) {
            console.error("Mitarbeiter-Zuordnung fehlgeschlagen:", assignError);
            warnings.push("Mitarbeiter-Zuordnung konnte nicht gespeichert werden");
          }
        }

        const signedSlugs = Object.entries(customerSignatures).filter(([, data]) => data && data.startsWith("data:image/"));
        if (signedSlugs.length > 0) {
          try {
            await api.post(`/customers/${customer.id}/signatures`, {
              signatures: signedSlugs.map(([slug, signatureData]) => ({
                templateSlug: slug,
                customerSignatureData: signatureData,
              })),
              signingLocation: signingLocationRef.current,
            });
          } catch (sigError) {
            console.error("Unterschriften-Speicherung fehlgeschlagen:", sigError);
            warnings.push("Unterschriften konnten nicht gespeichert werden");
          }
        }

        if (uploadedDocuments.length > 0) {
          try {
            for (const doc of uploadedDocuments) {
              await api.post(`/customers/${customer.id}/documents`, {
                documentTypeId: doc.documentTypeId,
                fileName: doc.fileName,
                objectPath: doc.objectPath,
              });
            }
          } catch (docError) {
            console.error("Dokument-Upload-Speicherung fehlgeschlagen:", docError);
            warnings.push("Hochgeladene Dokumente konnten nicht gespeichert werden");
          }
        }

        if (formData.documentDeliveryMethod) {
          try {
            await api.post(`/admin/document-delivery/send-for-customer/${customer.id}`, {});
          } catch (deliveryError) {
            console.error("Dokumentenversand fehlgeschlagen:", deliveryError);
            warnings.push("Dokumentenversand konnte nicht ausgelöst werden");
          }
        }

        if (warnings.length > 0) {
          toast({ title: "Kunde erstellt mit Hinweisen", description: warnings.join("; ") });
        } else {
          toast({ title: "Kunde erfolgreich erstellt" });
        }
        setLocation(`/admin/customers/${customer.id}`);
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  };

  const handleBudgetTypeToggle = useCallback((budgetType: BudgetType, enabled: boolean) => {
    setFormData((prev) => ({
      ...prev,
      budgetTypeSettings: prev.budgetTypeSettings.map((s) =>
        s.budgetType === budgetType ? { ...s, enabled } : s
      ),
    }));
  }, []);

  const handleBudgetTypeLimitChange = useCallback((budgetType: BudgetType, field: "monthlyLimitCents" | "yearlyLimitCents", value: string) => {
    setFormData((prev) => ({
      ...prev,
      budgetTypeSettings: prev.budgetTypeSettings.map((s) =>
        s.budgetType === budgetType ? { ...s, [field]: value } : s
      ),
    }));
  }, []);

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
        const currentValue = parseFloat(prev.pflegesachleistungen36);
        if (!currentValue || currentValue === 0) {
          newData.pflegesachleistungen36 = (maxCents / 100).toString();
        }
      }
      return newData;
    });
  };

  const getStepErrors = (stepId: string): string[] => {
    const errors: string[] = [];
    switch (stepId) {
      case "customerType":
        if (!formData.billingType) errors.push("Bitte Kundentyp auswählen");
        break;
      case "personal":
        if (!formData.vorname.trim()) errors.push("Vorname fehlt");
        if (!formData.nachname.trim()) errors.push("Nachname fehlt");
        if (!formData.strasse.trim()) errors.push("Straße fehlt");
        if (!formData.nr.trim()) errors.push("Hausnummer fehlt");
        if (!formData.plz.trim()) {
          errors.push("PLZ fehlt");
        } else if (!/^\d{5}$/.test(formData.plz.trim())) {
          errors.push("PLZ muss genau 5 Ziffern haben");
        }
        if (!formData.stadt.trim()) errors.push("Stadt fehlt");
        if (isPflegekasseCustomer(formData.billingType)) {
          if (!formData.geburtsdatum) errors.push("Geburtsdatum fehlt");
          if (!formData.pflegegrad || formData.pflegegrad === "0") errors.push("Pflegegrad auswählen");
          if (!formData.pflegegradSeit) errors.push("Pflegegrad seit fehlt");
        }
        break;
      case "insurance":
        if (formData.insuranceProviderId && !formData.versichertennummer.trim()) {
          errors.push("Versichertennummer fehlt");
        }
        break;
      case "contract":
        if (!formData.contractDate) errors.push("Vertragsabschluss-Datum fehlt");
        if (!formData.contractStart) errors.push("Vertragsbeginn fehlt");
        if (!formData.vereinbarteLeistungen.trim()) errors.push("Vereinbarte Leistungen ausfüllen");
        break;
      case "matching":
        if (!formData.primaryEmployeeId) errors.push("Hauptmitarbeiter zuordnen");
        break;
    }
    return errors;
  };

  const validateStepById = (stepId: string): boolean => {
    return getStepErrors(stepId).length === 0;
  };

  const handleNext = () => {
    if (currentStepId === "contacts") {
      const emptyContacts = formData.contacts.filter(c => !c.vorname.trim() && !c.nachname.trim());
      if (emptyContacts.length > 0) {
        const filledContacts = formData.contacts.filter(c => c.vorname.trim() || c.nachname.trim());
        if (filledContacts.length === 0) {
          filledContacts.push({ ...formData.contacts[0] });
        }
        setFormData(prev => ({ ...prev, contacts: filledContacts.length > 0 ? filledContacts : prev.contacts }));
        const userAddedEmpty = formData.contacts.length > 1 && emptyContacts.length > 0;
        if (userAddedEmpty) {
          toast({
            title: "Leere Kontakte entfernt",
            description: `${emptyContacts.length} leere${emptyContacts.length === 1 ? "r" : ""} Kontakt${emptyContacts.length === 1 ? "" : "e"} wurde${emptyContacts.length === 1 ? "" : "n"} entfernt.`,
          });
        }
      }
    }
    const errors = getStepErrors(currentStepId);
    if (errors.length === 0) {
      if (currentStep < steps.length - 1) {
        goToStep(currentStep + 1);
      }
    } else {
      toast({
        title: "Bitte korrigieren",
        description: errors.join(" · "),
        variant: "destructive",
      });
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      goToStep(currentStep - 1);
    }
  };

  const findStepIndex = (stepId: string) => steps.findIndex((s) => s.id === stepId);

  const handleSubmit = () => {
    const stepsToValidate = ["personal", "insurance", "contract", "matching"];
    for (const stepId of stepsToValidate) {
      const idx = findStepIndex(stepId);
      if (idx < 0) continue;
      const errors = getStepErrors(stepId);
      if (errors.length > 0) {
        goToStep(idx);
        toast({
          title: "Bitte korrigieren",
          description: errors.join(" · "),
          variant: "destructive",
        });
        return;
      }
    }
    handleCreate();
  };

  const renderStepContent = () => {
    switch (currentStepId) {
      case "customerType":
        return (
          <CustomerTypeStep
            selectedType={formData.billingType}
            onChange={(type) => {
              setFormData((prev) => ({ ...prev, billingType: type }));
              if (currentStep < steps.length - 1) {
                setTimeout(() => goToStep(currentStep + 1), 150);
              }
            }}
          />
        );
      case "personal":
        return (
          <PersonalDataStep
            formData={formData}
            phoneErrors={phoneErrors}
            onChange={handleChange}
          />
        );
      case "insurance":
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
      case "contacts":
        return (
          <ContactsStep
            contacts={formData.contacts}
            phoneErrors={phoneErrors}
            onContactChange={handleContactChange}
            onAddContact={handleAddContact}
            onRemoveContact={handleRemoveContact}
          />
        );
      case "budgets":
        return (
          <BudgetsStep
            formData={formData}
            onChange={handleChange}
            onBudgetTypeToggle={handleBudgetTypeToggle}
            onBudgetTypeLimitChange={handleBudgetTypeLimitChange}
            pflegegrad={formData.pflegegrad ? parseInt(formData.pflegegrad) : null}
          />
        );
      case "contract":
        return (
          <ContractStep
            formData={formData}
            onChange={handleChange}
            showGrossPrices={!isPflegekasseCustomer(formData.billingType)}
          />
        );
      case "signatures":
        return (
          <SignaturesStep
            billingType={formData.billingType}
            customerSignatures={customerSignatures}
            onSignatureChange={handleSignatureChange}
            uploadedDocuments={uploadedDocuments}
            onUploadedDocumentsChange={setUploadedDocuments}
            formData={formData}
          />
        );
      case "delivery":
        return (
          <DeliveryStep
            formData={formData}
            onChange={(field, value) => {
              handleChange(field, value);
              if (currentStep < steps.length - 1) {
                setTimeout(() => goToStep(currentStep + 1), 150);
              }
            }}
          />
        );
      case "matching":
        return (
          <MatchingStep
            formData={formData}
            onChange={handleChange}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin/customers">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className={componentStyles.pageTitle}>Neuen Kunden anlegen</h1>
          </div>

          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3 justify-center">
              <span className="text-sm font-semibold text-teal-700">
                {steps[currentStep].title}
              </span>
              <span className="text-xs text-gray-400">
                ({currentStep + 1}/{steps.length})
              </span>
            </div>
            <div className="flex items-center justify-center gap-2">
              {steps.map((step, index) => {
                const isActive = index === currentStep;
                const isCompleted = index < currentStep;

                return (
                  <div
                    key={step.id}
                    className={`rounded-full transition-all ${
                      isActive
                        ? "w-8 h-2 bg-teal-600"
                        : isCompleted
                        ? "w-2 h-2 bg-teal-600"
                        : "w-2 h-2 bg-gray-300"
                    }`}
                    title={step.title}
                  />
                );
              })}
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

                {currentStep === steps.length - 1 ? (
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
    </Layout>
  );
}
