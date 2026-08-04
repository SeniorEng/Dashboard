import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useInsuranceProviders, useCreateCustomer } from "@/features/customers";
import { api, ApiError } from "@/lib/api";
import { validateDachPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { centsToEuroNumber } from "@shared/utils/money";
import { CustomerFormData, ContactFormData, BudgetTypeSettingForm, getStepsForBillingType, DEFAULT_BUDGETS, EMPTY_CONTACT, MAX_CONTACTS } from "../components/wizard/customer-types";
import { BUDGET_45A_MAX_BY_PFLEGEGRAD, BUDGET_TYPES, type BudgetType } from "@shared/domain/budgets";
import { budgetsStepErrors } from "../components/wizard/budgets-step-validation";
import { isPflegekasseCustomer, type BillingType } from "@shared/domain/customers";
import { firstInsuranceAnchorISO } from "@shared/domain/insurance-period";
import { validateVersichertennummerFor } from "@shared/schema/common";
import type { WizardUploadedDoc } from "../components/wizard/signatures-step";
import type { DuplicateDialogEntry } from "../components/wizard/wizard-dialogs";
import { loadDraft, saveDraft, clearDraft } from "../lib/customer-draft";

function generateIdempotencyKey(): string {
  // Bevorzugt crypto.randomUUID(); Fallback nur, falls nicht vorhanden.
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createInitialFormData(): CustomerFormData {
  return {
    billingType: "",
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
    backupEmployeeId2: "",
    vorerkrankungen: "",
    haustierVorhanden: false,
    haustierDetails: "",
    personenbefoerderungGewuenscht: false,
    insuranceProviderId: "",
    versichertennummer: "",
    beihilfeBerechtigt: false,
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
    receivesMonthlyInvoice: false,
    acceptsPrivatePayment: false,
    rechnungAnKunde: false,
    uebertrag45b: "0",
    restguthaben45bOverrideEnabled: false,
    restguthaben45bStichmonat: todayISO().slice(0, 7),
    restguthaben45b: "0",
  };
}

export function useCustomerWizard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<CustomerFormData>(createInitialFormData);

  const [customerSignatures, setCustomerSignatures] = useState<Record<string, string>>({});
  const customerSignaturesRef = useRef<Record<string, string>>({});
  const [uploadedDocuments, setUploadedDocuments] = useState<WizardUploadedDoc[]>([]);
  const uploadedDocumentsRef = useRef<WizardUploadedDoc[]>([]);
  const signingLocationRef = useRef<string | null>(null);
  const [draftDialog, setDraftDialog] = useState<{ timestamp: string } | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<{ duplicates: DuplicateDialogEntry[] } | null>(null);
  const duplicateCheckedRef = useRef(false);
  // acknowledgeRecentDuplicate wird gesetzt, wenn der Server explizit
  // RECENT_DUPLICATE_WARNING (10-Min-Fenster) zurückgibt und der Anwender
  // den Dialog mit "Trotzdem neu anlegen" bestätigt.
  const acknowledgeRecentDuplicateRef = useRef(false);
  // Idempotency-Key bleibt für die gesamte Wizard-Sitzung stabil, damit
  // nach verlorener Antwort/Reload/Doppelklick der Server denselben Kunden
  // zurückliefert und nicht erneut anlegt. Wird im Draft persistiert.
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());
  const createdRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRestoringRef = useRef(false);
  const [phoneErrors, setPhoneErrors] = useState<Record<string, string | null>>({});
  const [duplicateChecking, setDuplicateChecking] = useState(false);

  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      setDraftDialog({ timestamp: draft.timestamp });
    }
  }, []);

  const restoreDraft = useCallback(() => {
    const draft = loadDraft();
    if (draft) {
      draftRestoringRef.current = true;
      setFormData(prev => ({ ...prev, ...draft.formData }));
      const restoredSteps = getStepsForBillingType(draft.formData.billingType ?? "");
      const clampedStep = Math.min(draft.currentStep, restoredSteps.length - 1);
      const targetStep = Math.max(1, clampedStep);
      setCurrentStep(targetStep);
      setDraftDialog(null);
      // Idempotency-Key aus dem Draft übernehmen, sonst würde ein neuer
      // Submit nach Reload als "echter neuer Kunde" gewertet.
      if (draft.idempotencyKey) {
        idempotencyKeyRef.current = draft.idempotencyKey;
      }
      setTimeout(() => {
        draftRestoringRef.current = false;
      }, 600);
      toast({ title: "Entwurf wiederhergestellt" });
    } else {
      setDraftDialog(null);
    }
  }, [toast]);

  const discardDraft = useCallback(() => {
    clearDraft();
    setDraftDialog(null);
  }, []);

  // Expliziter Wizard-Abbruch: Der Anwender verlässt die Anlage bewusst über
  // den Zurück-/Abbrechen-Button. Hier MUSS der Entwurf gelöscht werden,
  // damit keine (auch nicht-sensiblen) Eingaben auf einem geteilten Rechner
  // zurückbleiben. Der Restore-Flow ist nur für versehentliches Verlassen
  // (Reload/Crash/Tab-Schließen) gedacht.
  const handleCancel = useCallback(() => {
    clearDraft();
    setLocation("/admin/customers");
  }, [setLocation]);

  useEffect(() => {
    if (createdRef.current) return;
    if (draftDialog) return;
    if (draftRestoringRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (draftRestoringRef.current) return;
      if (draftDialog) return;
      const hasData = formData.vorname.trim() || formData.nachname.trim() || formData.billingType;
      if (hasData) {
        saveDraft({
          formData,
          currentStep,
          idempotencyKey: idempotencyKeyRef.current,
        });
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [formData, currentStep, draftDialog]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (createdRef.current) return;
      const hasData = formData.vorname.trim() || formData.nachname.trim();
      if (hasData) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [formData]);

  const handleSignatureChange = useCallback((slug: string, signatureData: string, location?: string | null) => {
    setCustomerSignatures((prev) => {
      const next = { ...prev, [slug]: signatureData };
      customerSignaturesRef.current = next;
      return next;
    });
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
    (insuranceProviders?.map((p) => ({
      value: p.id.toString(),
      label: p.isPrivate ? `${p.name} (Privat)` : p.name,
      sublabel: p.ikNummer ? `IK: ${p.ikNummer}` : "Privat",
    })) || []).sort((a, b) => a.label.localeCompare(b.label, "de")),
    [insuranceProviders]
  );

  const handleContactChange = useCallback((index: number, field: keyof ContactFormData, value: string | boolean) => {
    if ((field === "festnetz" || field === "mobilnummer") && typeof value === "string") {
      const formatted = formatPhoneAsYouType(value);
      setFormData((prev) => {
        const newContacts = [...prev.contacts];
        newContacts[index] = { ...newContacts[index], [field]: formatted };
        return { ...prev, contacts: newContacts };
      });
      if (value.trim()) {
        const validation = validateDachPhone(value);
        setPhoneErrors((prev) => ({ ...prev, [`contact_${index}_${field}`]: validation.valid ? null : validation.error || "Ungültige Telefonnummer" }));
      } else {
        setPhoneErrors((prev) => ({ ...prev, [`contact_${index}_${field}`]: null }));
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
      delete next[`contact_${index}_festnetz`];
      delete next[`contact_${index}_mobilnummer`];
      return next;
    });
  }, []);

  const handleCreate = (forceSkipDuplicate = false) => {
    const today = todayISO();
    
    const phoneValidationErrors: string[] = [];
    if (formData.telefon.trim()) {
      const result = validateDachPhone(formData.telefon);
      if (!result.valid) phoneValidationErrors.push(`Mobiltelefon: ${result.error}`);
    }
    if (formData.festnetz.trim()) {
      const result = validateDachPhone(formData.festnetz);
      if (!result.valid) phoneValidationErrors.push(`Festnetz: ${result.error}`);
    }
    formData.contacts.forEach((contact, index) => {
      if (contact.festnetz?.trim()) {
        const result = validateDachPhone(contact.festnetz);
        if (!result.valid) phoneValidationErrors.push(`Kontakt ${index + 1} Festnetz: ${result.error}`);
      }
      if (contact.mobilnummer?.trim()) {
        const result = validateDachPhone(contact.mobilnummer);
        if (!result.valid) phoneValidationErrors.push(`Kontakt ${index + 1} Mobilnummer: ${result.error}`);
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
    
    const versNr = formData.versichertennummer.trim();
    const selectedProvider = insuranceProviders?.find(p => p.id.toString() === formData.insuranceProviderId);
    const isPrivateProvider = selectedProvider?.isPrivate || false;
    const isPrivateCase = formData.billingType === "pflegekasse_privat" || isPrivateProvider;
    if (formData.insuranceProviderId && versNr) {
      // Zentrale Validierung verwenden, damit Frontend- und Backend-Regeln
      // garantiert übereinstimmen (siehe shared/schema/common.ts).
      const vnCheck = validateVersichertennummerFor(versNr, {
        billingType: formData.billingType,
        isPrivateProvider,
      });
      if (!vnCheck.ok) {
        toast({
          title: "Ungültige Versichertennummer",
          description: vnCheck.message,
          variant: "destructive",
        });
        return;
      }
    }

    // Task #1898 — ERSTZUORDNUNG, kein Wechsel: der Kunde wird hier gerade erst
    // angelegt, vorher war er keiner Kasse zugeordnet. `today` (mitten im Monat)
    // lief seit #1893 in den harten 400 „Kassenwechsel nur zum Monatsersten".
    // Gesendet wird der Anker, den auch der Server berechnet — damit zeigt die
    // Anfrage denselben Wert wie die gespeicherte Zeile.
    const insurance = formData.insuranceProviderId && versNr
      ? {
          providerId: parseInt(formData.insuranceProviderId),
          versichertennummer: versNr,
          validFrom: firstInsuranceAnchorISO(today, formData.contractStart || null, today),
        } 
      : undefined;

    const contacts = formData.contacts
      .filter(c => c.vorname.trim() && c.nachname.trim())
      .map(c => ({
        contactType: c.contactType,
        isPrimary: c.isPrimary,
        vorname: c.vorname.trim(),
        nachname: c.nachname.trim(),
        festnetz: c.festnetz?.trim() ? (normalizePhone(c.festnetz) || c.festnetz.trim()) : undefined,
        mobilnummer: c.mobilnummer?.trim() ? (normalizePhone(c.mobilnummer) || c.mobilnummer.trim()) : undefined,
        email: c.email.trim() || undefined,
        notes: c.notes.trim() || undefined,
      }));

    const is45bEnabled = formData.budgetTypeSettings.find(s => s.budgetType === "entlastungsbetrag_45b")?.enabled ?? false;
    const is45aEnabled = formData.budgetTypeSettings.find(s => s.budgetType === "umwandlung_45a")?.enabled ?? false;
    const is39Enabled = formData.budgetTypeSettings.find(s => s.budgetType === "ersatzpflege_39_42a")?.enabled ?? false;
    // Task #960 — Der Vorjahres-Übertrag ist nur bei Vertragsbeginn vor dem
    // 30.06. nutzbar (verfällt danach). Bei späterem Beginn wird das Feld
    // ausgeblendet und darf auch nicht gebucht werden.
    const carryover45bUsable = (formData.contractStart || today) < `${new Date().getFullYear()}-07-01`;
    const carryoverAmount = is45bEnabled && carryover45bUsable ? (Math.round(parseFloat(formData.uebertrag45b) * 100) || 0) : 0;
    // Task #960 — Optionaler §45b-Restguthaben-Override (laufendes Jahr). Nur
    // wenn aktiv, wird ein initial_balance für den Stichmonat gebucht; sonst
    // bleibt das §45b-Guthaben rein auto-renewal-getrieben (kein initial_balance).
    const override45bActive = is45bEnabled && formData.restguthaben45bOverrideEnabled;
    const override45bCents = override45bActive ? (Math.round(parseFloat(formData.restguthaben45b) * 100) || 0) : 0;
    const override45bStichmonatStart = override45bActive && formData.restguthaben45bStichmonat
      ? `${formData.restguthaben45bStichmonat}-01`
      : null;
    const budgetValues = {
      entlastungsbetrag45b: is45bEnabled ? (Math.round(parseFloat(formData.entlastungsbetrag45b) * 100) || 0) : 0,
      verhinderungspflege39: is39Enabled ? (Math.round(parseFloat(formData.verhinderungspflege39) * 100) || 0) : 0,
      pflegesachleistungen36: is45aEnabled ? (Math.round(parseFloat(formData.pflegesachleistungen36) * 100) || 0) : 0,
      validFrom: today,
      carryoverAmountCents: carryoverAmount > 0 ? carryoverAmount : undefined,
      // Task #1213 — §45b-Restguthaben-Override (laufendes Jahr) + Stichmonat-Start
      // fließen jetzt in DENSELBEN Anlage-Request; der Server bucht das
      // initial_balance innerhalb der Anlage-Transaktion (kein separater
      // `POST /budget/:id/initial-budget` mehr).
      override45bCents: override45bCents > 0 ? override45bCents : undefined,
      override45bStichmonatStart: override45bStichmonatStart || undefined,
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

    // Task #1213 — Unterschriften + hochgeladene Dokumente fließen in DENSELBEN
    // Anlage-Request. Der Server generiert die Signatur-PDFs und persistiert
    // alle Datensätze innerhalb der Anlage-Transaktion (kein separater
    // Folge-Aufruf mehr).
    const signedSlugs = Object.entries(customerSignaturesRef.current)
      .filter(([, data]) => data && data.startsWith("data:image/"));
    const signatures = signedSlugs.length > 0
      ? signedSlugs.map(([slug, signatureData]) => ({
          templateSlug: slug,
          customerSignatureData: signatureData,
        }))
      : undefined;
    const documents = uploadedDocumentsRef.current.length > 0
      ? uploadedDocumentsRef.current.map((d) => ({
          documentTypeId: d.documentTypeId,
          fileName: d.fileName,
          objectPath: d.objectPath,
        }))
      : undefined;

    const payload = {
      billingType: formData.billingType || undefined,
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
      vorerkrankungen: formData.vorerkrankungen.trim() || undefined,
      haustierVorhanden: formData.haustierVorhanden,
      haustierDetails: formData.haustierVorhanden ? (formData.haustierDetails.trim() || undefined) : undefined,
      personenbefoerderungGewuenscht: formData.personenbefoerderungGewuenscht,
      acceptsPrivatePayment: formData.acceptsPrivatePayment,
      rechnungAnKunde: formData.billingType === "pflegekasse_gesetzlich" ? formData.rechnungAnKunde : false,
      beihilfeBerechtigt: formData.billingType === "pflegekasse_privat" ? formData.beihilfeBerechtigt : false,
      documentDeliveryMethod: formData.documentDeliveryMethod,
      receivesMonthlyInvoice: formData.receivesMonthlyInvoice,
      insurance: isPflegekasse ? insurance : undefined,
      contacts: contacts.length > 0 ? contacts : undefined,
      budgets: isPflegekasse ? budgets : undefined,
      contract,
      signatures,
      signingLocation: signatures ? signingLocationRef.current : undefined,
      documents,
      primaryEmployeeId: formData.primaryEmployeeId ? parseInt(formData.primaryEmployeeId) : undefined,
      backupEmployeeId: formData.backupEmployeeId ? parseInt(formData.backupEmployeeId) : undefined,
      backupEmployeeId2: formData.backupEmployeeId2 ? parseInt(formData.backupEmployeeId2) : undefined,
      skipDuplicateCheck: duplicateCheckedRef.current || forceSkipDuplicate,
      acknowledgeRecentDuplicate: acknowledgeRecentDuplicateRef.current,
      __idempotencyKey: idempotencyKeyRef.current,
    };

    createMutation.mutate(payload, {
      onSuccess: (customer) => {
        // Task #1213 — Single atomic submit: Stammdaten, Versicherung, Budgets,
        // Vertrag, Kontakte, Mitarbeiter-Zuordnung, Unterschriften und Dokumente
        // werden allesamt server-seitig in EINER Transaktion persistiert. Keine
        // sekundären Folge-Aufrufe mehr — entweder alles committet oder gar
        // nichts (kein „halbangelegter" Kunde).
        createdRef.current = true;
        clearDraft();
        toast({ title: "Kunde erfolgreich erstellt" });
        setLocation(`/admin/customers/${customer.id}`);
      },
      onError: (error: Error) => {
        if (error instanceof ApiError) {
          if (error.code === "DUPLICATE_WARNING" || error.code === "RECENT_DUPLICATE_WARNING") {
            const dups = (error.details?.duplicates as Array<DuplicateDialogEntry> | undefined) || [];
            if (dups.length > 0) {
              setDuplicateWarning({ duplicates: dups });
              return;
            }
          }
          if (error.code === "IDEMPOTENCY_KEY_REUSED") {
            toast({
              title: "Anlage nicht möglich",
              description: "Die Daten haben sich seit dem letzten Versuch geändert. Bitte Seite neu laden und erneut anlegen.",
              variant: "destructive",
            });
            return;
          }
          if (error.code === "IDEMPOTENCY_IN_PROGRESS") {
            // Erstrequest läuft noch — fachlich identisch zu Netzwerk-/
            // Timeout-Retry: der Server schützt gegen Doppelanlage.
            toast({
              title: "Wird noch gespeichert",
              description: "Die vorige Anfrage läuft noch. Bitte gleich erneut speichern — der Vorgang ist gegen Doppelanlage geschützt.",
              variant: "destructive",
            });
            return;
          }
          if (error.code === "NETWORK_ERROR") {
            toast({
              title: "Netzwerkfehler",
              description: "Verbindung zum Server fehlgeschlagen. Bitte Internetverbindung prüfen und erneut versuchen — der Vorgang ist gegen Doppelanlage geschützt.",
              variant: "destructive",
            });
            return;
          }
        }
        // 5xx und andere unerwartete Fehler: klare Botschaft + Hinweis auf Retry-Sicherheit.
        const status = error instanceof ApiError ? error.status : undefined;
        if (typeof status === "number" && status >= 500) {
          toast({
            title: "Serverfehler",
            description: "Der Server konnte die Anlage nicht verarbeiten. Bitte erneut versuchen — der Vorgang ist gegen Doppelanlage geschützt.",
            variant: "destructive",
          });
          return;
        }
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
        const validation = validateDachPhone(value);
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
          newData.pflegesachleistungen36 = centsToEuroNumber(maxCents).toString();
        }
      }
      // Task #860 — Kein Auto-Berechnen des §45b-Übertrags mehr. Das Vorjahr gilt
      // beim Onboarding als aufgebraucht (Default-Übertrag 0 €). Ein tatsächlich
      // verbliebenes Restguthaben trägt der Operator manuell in `uebertrag45b` ein.
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
        }
        break;
      case "insurance":
        if (formData.insuranceProviderId && !formData.versichertennummer.trim()) {
          errors.push("Versichertennummer fehlt");
        }
        break;
      case "budgets":
        // Task #982 — Block-Logik des Budget-Schritts lebt als reine SSoT in
        // `budgetsStepErrors`, damit das "Weiter"-Blockieren (insb. die §45b-
        // Startwert-Obergrenze) deterministisch unit-getestet werden kann.
        errors.push(...budgetsStepErrors(formData, new Date().getFullYear(), todayISO()));
        break;
      case "contract":
        if (!formData.contractDate) errors.push("Vertragsabschluss-Datum fehlt");
        if (!formData.contractStart) errors.push("Vertragsbeginn fehlt");
        if (!formData.vereinbarteLeistungen.trim()) errors.push("Vereinbarte Leistungen ausfüllen");
        break;
      case "delivery":
        if (formData.documentDeliveryMethod === "email" && !formData.email.trim()) {
          errors.push("E-Mail-Adresse ist erforderlich für den E-Mail-Versand");
        }
        break;
      case "matching":
        break;
    }
    return errors;
  };

  const prevNameRef = useRef({ vorname: "", nachname: "", geburtsdatum: "" });
  useEffect(() => {
    const cur = { vorname: formData.vorname.trim(), nachname: formData.nachname.trim(), geburtsdatum: formData.geburtsdatum };
    if (cur.vorname !== prevNameRef.current.vorname || cur.nachname !== prevNameRef.current.nachname || cur.geburtsdatum !== prevNameRef.current.geburtsdatum) {
      duplicateCheckedRef.current = false;
    }
    prevNameRef.current = cur;
  }, [formData.vorname, formData.nachname, formData.geburtsdatum]);

  const handleNext = async () => {
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
    if (errors.length > 0) {
      toast({
        title: "Bitte korrigieren",
        description: errors.join(" · "),
        variant: "destructive",
      });
      return;
    }

    if (currentStepId === "personal" && !duplicateCheckedRef.current) {
      const vorname = formData.vorname.trim();
      const nachname = formData.nachname.trim();
      if (vorname && nachname) {
        try {
          setDuplicateChecking(true);
          const params = new URLSearchParams({ vorname, nachname });
          if (formData.geburtsdatum) params.set("geburtsdatum", formData.geburtsdatum);
          const dupResult = await api.get<{ duplicates: Array<{ id: number; vorname: string; nachname: string; geburtsdatum: string | null; stadt: string | null; strasse: string | null; nr: string | null; status: string | null }> }>(`/admin/customers/check-duplicate?${params.toString()}`);
          if (dupResult.success && dupResult.data.duplicates && dupResult.data.duplicates.length > 0) {
            setDuplicateWarning({ duplicates: dupResult.data.duplicates });
            setDuplicateChecking(false);
            return;
          }
        } catch (dupError) {
          console.warn("Duplikatprüfung fehlgeschlagen:", dupError);
        } finally {
          setDuplicateChecking(false);
        }
        // duplicateCheckedRef wird NICHT mehr automatisch nach erfolgreichem
        // Duplicate-Check gesetzt. Nur ein expliziter Klick auf "Trotzdem
        // neu anlegen" im DuplicateDialog (-> handleDuplicateContinue) darf
        // skipDuplicateCheck im Submit-Payload aktivieren. Damit ist der
        // Server-Duplikat-Check beim finalen Submit weiterhin aktiv, falls
        // sich Vor-/Nachname/Geburtsdatum nach diesem Schritt noch ändern.
      }
    }

    if (currentStep < steps.length - 1) {
      goToStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      goToStep(currentStep - 1);
    }
  };

  const findStepIndex = (stepId: string) => steps.findIndex((s) => s.id === stepId);

  const handleSubmit = () => {
    const stepsToValidate = ["personal", "insurance", "budgets", "contract", "delivery", "matching"];
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

  const handleUploadedDocumentsChange = useCallback((docs: WizardUploadedDoc[]) => {
    setUploadedDocuments(docs);
    uploadedDocumentsRef.current = docs;
  }, []);

  const handleDuplicateContinue = useCallback(() => {
    duplicateCheckedRef.current = true;
    acknowledgeRecentDuplicateRef.current = true;
    setDuplicateWarning(null);
    if (currentStep < steps.length - 1) {
      goToStep(currentStep + 1);
    } else {
      handleCreate(true);
    }
  }, [currentStep, steps.length, goToStep]);

  const handleDuplicateOpenExisting = useCallback((id: number) => {
    // Bestätigung vor Verwerfen des Wizard-Entwurfs (Task #376):
    // Sobald Eingaben gemacht wurden, könnte der Nutzer ungewollt Daten
    // verlieren. Bei leerem Formular ohne Rückfrage navigieren.
    const hasDraftContent =
      !!formData.vorname?.trim() ||
      !!formData.nachname?.trim() ||
      !!formData.geburtsdatum ||
      !!formData.strasse?.trim() ||
      !!formData.plz?.trim() ||
      !!formData.stadt?.trim() ||
      (Array.isArray(formData.contacts) && formData.contacts.length > 0);
    if (hasDraftContent) {
      const ok = typeof window !== "undefined"
        ? window.confirm(
            "Wenn du den bestehenden Kunden öffnest, wird der aktuelle Entwurf verworfen. Fortfahren?",
          )
        : true;
      if (!ok) return;
    }
    setDuplicateWarning(null);
    clearDraft();
    setLocation(`/admin/customers/${id}`);
  }, [formData, setLocation]);

  const handleDuplicateCancel = useCallback(() => {
    setDuplicateWarning(null);
  }, []);

  const handleBillingTypeChange = useCallback((type: BillingType) => {
    setFormData((prev) => ({ ...prev, billingType: type }));
    if (currentStep < steps.length - 1) {
      setTimeout(() => goToStep(currentStep + 1), 150);
    }
  }, [currentStep, steps.length, goToStep]);

  const handleInsuranceProviderCreated = useCallback((providerId: string) => {
    setFormData((prev) => ({ ...prev, insuranceProviderId: providerId }));
  }, []);

  return {
    formData,
    currentStep,
    steps,
    currentStepId,
    customerSignatures,
    uploadedDocuments,
    draftDialog,
    duplicateWarning,
    duplicateChecking,
    phoneErrors,
    insuranceOptions,
    insuranceProviders,
    createMutation,

    handleChange,
    handleContactChange,
    handleAddContact,
    handleRemoveContact,
    handleSignatureChange,
    handleBudgetTypeToggle,
    handleBudgetTypeLimitChange,
    handleUploadedDocumentsChange,
    handleBillingTypeChange,
    handleInsuranceProviderCreated,
    getStepErrors,
    handleNext,
    handleBack,
    handleSubmit,
    restoreDraft,
    discardDraft,
    handleCancel,
    handleDuplicateContinue,
    handleDuplicateCancel,
    handleDuplicateOpenExisting,
  };
}
