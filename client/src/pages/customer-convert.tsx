import { useState, useMemo, useCallback, useEffect } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { useInsuranceProviders } from "@/features/customers";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO } from "@shared/utils/datetime";
import { api, unwrapResult } from "@/lib/api/client";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
  UserCheck,
  FileText,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { CustomerFormData, ContactFormData, BudgetTypeSettingForm, getStepsForBillingType, DEFAULT_BUDGETS, EMPTY_CONTACT, MAX_CONTACTS } from "./admin/components/customer-types";
import { BUDGET_45A_MAX_BY_PFLEGEGRAD, BUDGET_TYPES, type BudgetType } from "@shared/domain/budgets";
import { isPflegekasseCustomer, type BillingType } from "@shared/domain/customers";
import { CustomerTypeStep } from "./admin/components/customer-type-step";
import { PersonalDataStep } from "./admin/components/personal-data-step";
import { InsuranceStep } from "./admin/components/insurance-step";
import { ContactsStep } from "./admin/components/contacts-step";
import { BudgetsStep, ContractStep } from "./admin/components/budgets-contract-step";
import { SignaturesStep } from "./admin/components/signatures-step";
import { DeliveryStep } from "./admin/components/delivery-step";
import { MatchingStep } from "./admin/components/matching-step";
import { ErrorState } from "@/components/patterns/error-state";
import type { Customer } from "@shared/schema";

export default function CustomerConvertPage() {
  const [, params] = useRoute("/customer/:id/convert");
  const customerId = params?.id ? parseInt(params.id, 10) : null;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState(0);
  const goToStep = useCallback((step: number) => {
    setCurrentStep(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const [initialized, setInitialized] = useState(false);

  const fromAppointmentId = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const val = urlParams.get("fromAppointment");
    return val ? parseInt(val, 10) : null;
  }, []);

  const { data: customer, isLoading, error, refetch } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${customerId}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: sourceAppointment } = useQuery<{ id: number; notes: string | null; date: string; scheduledStart: string | null; scheduledEnd: string | null }>({
    queryKey: ["appointment", fromAppointmentId],
    queryFn: async () => {
      const result = await api.get<any>(`/appointments/${fromAppointmentId}`);
      return unwrapResult(result);
    },
    enabled: !!fromAppointmentId,
  });

  const [formData, setFormData] = useState<CustomerFormData>({
    billingType: "pflegekasse_gesetzlich",
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
      enabled: true,
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
    documentDeliveryMethod: "email" as const,
    acceptsPrivatePayment: false,
  });

  const [appointmentNotesPrefilled, setAppointmentNotesPrefilled] = useState(false);

  useEffect(() => {
    if (customer && !initialized) {
      setFormData((prev) => ({
        ...prev,
        vorname: customer.vorname || "",
        nachname: customer.nachname || "",
        geburtsdatum: customer.geburtsdatum || "",
        email: customer.email || "",
        telefon: customer.telefon || "",
        festnetz: customer.festnetz || "",
        strasse: customer.strasse || "",
        nr: customer.nr || "",
        plz: customer.plz || "",
        stadt: customer.stadt || "",
        pflegegrad: customer.pflegegrad ? customer.pflegegrad.toString() : "0",
        billingType: (customer.billingType as BillingType) || "pflegekasse_gesetzlich",
        primaryEmployeeId: customer.primaryEmployeeId ? customer.primaryEmployeeId.toString() : "",
        backupEmployeeId: customer.backupEmployeeId ? customer.backupEmployeeId.toString() : "",
        haustierVorhanden: customer.haustierVorhanden || false,
        haustierDetails: customer.haustierDetails || "",
        personenbefoerderungGewuenscht: customer.personenbefoerderungGewuenscht || false,
        vorerkrankungen: customer.vorerkrankungen || "",
      }));
      setInitialized(true);
    }
  }, [customer, initialized]);

  useEffect(() => {
    if (sourceAppointment?.notes && !appointmentNotesPrefilled) {
      setFormData((prev) => ({
        ...prev,
        vereinbarteLeistungen: prev.vereinbarteLeistungen || sourceAppointment.notes || "",
      }));
      setAppointmentNotesPrefilled(true);
    }
  }, [sourceAppointment, appointmentNotesPrefilled]);

  const [customerSignatures, setCustomerSignatures] = useState<Record<string, string>>({});
  const [uploadedDocuments, setUploadedDocuments] = useState<import("./admin/components/signatures-step").WizardUploadedDoc[]>([]);

  const handleSignatureChange = useCallback((slug: string, signatureData: string) => {
    setCustomerSignatures((prev) => ({ ...prev, [slug]: signatureData }));
  }, []);

  const steps = useMemo(() => getStepsForBillingType(formData.billingType), [formData.billingType]);
  const currentStepId = steps[currentStep]?.id || "customerType";

  const { data: insuranceProviders } = useInsuranceProviders();

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

  const convertMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const result = await api.post(`/customers/${customerId}/convert`, payload);
      return unwrapResult(result);
    },
    onSuccess: async () => {
      const warnings: string[] = [];

      const signedSlugs = Object.entries(customerSignatures).filter(([, data]) => data && data.startsWith("data:image/"));
      if (signedSlugs.length > 0) {
        try {
          await api.post(`/customers/${customerId}/signatures`, {
            signatures: signedSlugs.map(([slug, signatureData]) => ({
              templateSlug: slug,
              customerSignatureData: signatureData,
            })),
          });
        } catch (sigError) {
          console.error("Unterschriften-Speicherung fehlgeschlagen:", sigError);
          warnings.push("Unterschriften konnten nicht gespeichert werden");
        }
      }

      if (uploadedDocuments.length > 0) {
        try {
          for (const doc of uploadedDocuments) {
            await api.post(`/customers/${customerId}/documents`, {
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
          await api.post(`/admin/document-delivery/send-for-customer/${customerId}`, {});
        } catch (deliveryError) {
          console.error("Dokumentenversand fehlgeschlagen:", deliveryError);
          warnings.push("Dokumentenversand konnte nicht ausgelöst werden");
        }
      }

      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });

      if (warnings.length > 0) {
        toast({ title: "Kunde aktiviert mit Hinweisen", description: warnings.join("; ") });
      } else {
        toast({ title: "Kunde erfolgreich aktiviert" });
      }
      setLocation(`/customer/${customerId}`);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleConvert = () => {
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
      acceptsPrivatePayment: formData.acceptsPrivatePayment,
      insurance: isPflegekasse ? insurance : undefined,
      contacts: contacts.length > 0 ? contacts : undefined,
      budgets: isPflegekasse ? budgets : undefined,
      contract,
      primaryEmployeeId: formData.primaryEmployeeId ? parseInt(formData.primaryEmployeeId) : null,
      backupEmployeeId: formData.backupEmployeeId ? parseInt(formData.backupEmployeeId) : null,
    };

    convertMutation.mutate(payload);
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

  const validateStepById = (stepId: string): boolean => {
    switch (stepId) {
      case "customerType":
        return !!formData.billingType;
      case "personal": {
        const base = !!(
          formData.vorname &&
          formData.nachname &&
          formData.strasse &&
          formData.nr &&
          formData.plz &&
          formData.stadt
        );
        if (isPflegekasseCustomer(formData.billingType)) {
          return base && !!formData.geburtsdatum && !!formData.pflegegrad && formData.pflegegrad !== "0";
        }
        return base;
      }
      case "insurance":
        if (formData.insuranceProviderId) {
          return !!formData.versichertennummer;
        }
        return true;
      case "contract":
        return !!(
          formData.contractDate &&
          formData.contractStart &&
          formData.vereinbarteLeistungen.trim()
        );
      case "matching":
        return !!formData.primaryEmployeeId;
      default:
        return true;
    }
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
      }
    }
    if (validateStepById(currentStepId)) {
      if (currentStep < steps.length - 1) {
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

  const findStepIndex = (stepId: string) => steps.findIndex((s) => s.id === stepId);

  const handleSubmit = () => {
    const personalIdx = findStepIndex("personal");
    if (personalIdx >= 0 && !validateStepById("personal")) {
      setCurrentStep(personalIdx);
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Bitte füllen Sie die persönlichen Daten vollständig aus.",
        variant: "destructive",
      });
      return;
    }
    const contractIdx = findStepIndex("contract");
    if (contractIdx >= 0 && !validateStepById("contract")) {
      setCurrentStep(contractIdx);
      toast({
        title: "Pflichtfelder ausfüllen",
        description: "Bitte füllen Sie die Vertragsdaten vollständig aus.",
        variant: "destructive",
      });
      return;
    }
    if (!validateStepById("matching")) {
      toast({
        title: "Hauptansprechpartner fehlt",
        description: "Bitte wählen Sie einen Hauptansprechpartner aus.",
        variant: "destructive",
      });
      return;
    }
    handleConvert();
  };

  const renderStepContent = () => {
    switch (currentStepId) {
      case "customerType":
        return (
          <CustomerTypeStep
            selectedType={formData.billingType}
            onChange={(type) => {
              setFormData((prev) => ({ ...prev, billingType: type }));
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
          />
        );
      case "delivery":
        return (
          <DeliveryStep
            formData={formData}
            onChange={(field, value) => {
              handleChange(field, value);
              if (field === "documentDeliveryMethod" && currentStep < steps.length - 1) {
                const shouldAutoAdvance = value === "post" || formData.email.trim();
                if (shouldAutoAdvance) {
                  setTimeout(() => goToStep(currentStep + 1), 150);
                }
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

  if (isLoading) {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (error || !customer) {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Kunde konnte nicht geladen werden"
            description={error instanceof Error ? error.message : "Der Kunde wurde nicht gefunden."}
            onRetry={() => refetch()}
          />
        </div>
      </Layout>
    );
  }

  if (customer.status !== "erstberatung") {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Konvertierung nicht möglich"
            description="Dieser Kunde ist kein Erstberatungskunde und kann nicht konvertiert werden."
          />
        </div>
      </Layout>
    );
  }

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-4">
            <Link href={`/customer/${customerId}`}>
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className={componentStyles.pageTitle} data-testid="text-convert-title">
                Kunde übernehmen
              </h1>
              <p className="text-sm text-muted-foreground">
                {customer.vorname} {customer.nachname} als aktiven Kunden anlegen
              </p>
            </div>
          </div>

          <Card className="mb-4 border-teal-200 bg-teal-50/50">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-2">
                <UserCheck className={`${iconSize.sm} text-teal-600`} />
                <span className="text-sm text-teal-700">
                  Vorhandene Daten wurden übernommen. Bitte vervollständigen Sie die fehlenden Angaben.
                </span>
              </div>
            </CardContent>
          </Card>

          {sourceAppointment?.notes && (
            <Card className="mb-4 border-amber-200 bg-amber-50/50">
              <CardContent className="py-3 px-4">
                <div className="flex items-start gap-2">
                  <FileText className={`${iconSize.sm} text-amber-600 mt-0.5 shrink-0`} />
                  <div>
                    <span className="text-sm font-medium text-amber-800">Notizen aus der Erstberatung</span>
                    <p className="text-sm text-amber-700 mt-1 whitespace-pre-wrap">{sourceAppointment.notes}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

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
                    disabled={convertMutation.isPending}
                    data-testid="button-submit-convert"
                  >
                    {convertMutation.isPending ? (
                      <>
                        <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                        Aktivieren...
                      </>
                    ) : (
                      <>
                        Kunde aktivieren
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
