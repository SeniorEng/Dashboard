import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult, ApiError } from "@/lib/api";
import { DuplicateDialog } from "@/pages/admin/components/wizard-dialogs";
import { iconSize, componentStyles } from "@/design-system";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  CheckCircle2,
  FileText,
  User,
  Wallet,
  Users,
  ScrollText,
  Save,
} from "lucide-react";
import { PFLEGEGRAD_SELECT_OPTIONS, BILLING_TYPE_SELECT_OPTIONS, CONTACT_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import { todayISO } from "@shared/utils/datetime";

interface ProspectData {
  id: number;
  vorname: string;
  nachname: string;
  telefon: string | null;
  email: string | null;
  strasse: string | null;
  nr: string | null;
  plz: string | null;
  stadt: string | null;
  pflegegrad: number | null;
}

interface EmployeeOption {
  id: number;
  displayName: string;
  isActive: boolean;
}

interface InsuranceProviderOption {
  id: number;
  name: string;
  ikNummer: string;
  isPrivate?: boolean;
}

const STEPS = [
  { id: "billing-type", title: "Abrechnungsart", icon: Wallet },
  { id: "personal-data", title: "Persönliche Daten", icon: User },
  { id: "contract", title: "Vertrag", icon: ScrollText },
  { id: "budgets", title: "Budgets", icon: Wallet },
  { id: "contacts-signatures", title: "Kontakte & Unterschriften", icon: Users },
  { id: "employees", title: "Mitarbeiter", icon: Users },
];

export default function ProspectConvert() {
  const params = useParams<{ id: string }>();
  const prospectId = parseInt(params.id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState(0);

  const { data: prospect, isLoading: prospectLoading } = useQuery<ProspectData>({
    queryKey: ["prospect-appointment-data", prospectId],
    queryFn: async () => {
      const result = await api.get<{ prospect: ProspectData; appointments: unknown[] }>(`/admin/prospects/${prospectId}/appointment-data`);
      const data = unwrapResult(result);
      return data.prospect;
    },
    enabled: prospectId > 0,
  });

  interface ProspectOffer {
    id: number;
    wizardData: Record<string, string>;
    status: string;
  }

  const { data: openOffer } = useQuery<ProspectOffer | null>({
    queryKey: ["prospect-offer", prospectId],
    queryFn: async () => {
      const result = await api.get<ProspectOffer>(`/admin/prospects/${prospectId}/offer`);
      return unwrapResult(result);
    },
    enabled: prospectId > 0,
  });

  const { data: employees = [] } = useQuery<EmployeeOption[]>({
    queryKey: ["/api/admin/employees"],
    staleTime: 60_000,
  });

  const { data: insuranceProviders = [] } = useQuery<InsuranceProviderOption[]>({
    queryKey: ["/api/insurance-providers"],
    staleTime: 60_000,
  });

  const [billingType, setBillingType] = useState("");
  const [vorname, setVorname] = useState("");
  const [nachname, setNachname] = useState("");
  const [geburtsdatum, setGeburtsdatum] = useState("");
  const [email, setEmail] = useState("");
  const [telefon, setTelefon] = useState("");
  const [festnetz, setFestnetz] = useState("");
  const [strasse, setStrasse] = useState("");
  const [nr, setNr] = useState("");
  const [plz, setPlz] = useState("");
  const [stadt, setStadt] = useState("");
  const [pflegegrad, setPflegegrad] = useState("");
  const [pflegegradSeit, setPflegegradSeit] = useState("");
  const [vorerkrankungen, setVorerkrankungen] = useState("");
  const [acceptsPrivatePayment, setAcceptsPrivatePayment] = useState(false);
  const [documentDeliveryMethod, setDocumentDeliveryMethod] = useState("email");
  const [insuranceProviderId, setInsuranceProviderId] = useState("");
  const [versichertennummer, setVersichertennummer] = useState("");
  const [contractStart, setContractStart] = useState(todayISO());
  const [contractDate, setContractDate] = useState(todayISO());
  const [vereinbarteLeistungen, setVereinbarteLeistungen] = useState("");
  const [contractHours, setContractHours] = useState("0");
  const [contractPeriod, setContractPeriod] = useState("weekly");
  const [entlastungsbetrag45b, setEntlastungsbetrag45b] = useState("12500");
  const [verhinderungspflege39, setVerhinderungspflege39] = useState("161200");
  const [pflegesachleistungen36, setPflegesachleistungen36] = useState("0");
  const [contactVorname, setContactVorname] = useState("");
  const [contactNachname, setContactNachname] = useState("");
  const [contactFestnetz, setContactFestnetz] = useState("");
  const [contactMobilnummer, setContactMobilnummer] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactType, setContactType] = useState("sonstige");
  const [primaryEmployeeId, setPrimaryEmployeeId] = useState("");
  const [backupEmployeeId, setBackupEmployeeId] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState<{ duplicates: Array<{ id: number; vorname: string; nachname: string; geburtsdatum: string | null; stadt: string | null; strasse: string | null; nr: string | null; status: string | null }> } | null>(null);

  const prospectHydrated = useRef(false);
  const offerHydrated = useRef(false);

  useEffect(() => {
    if (prospect && !prospectHydrated.current) {
      prospectHydrated.current = true;
      setVorname(prospect.vorname || "");
      setNachname(prospect.nachname || "");
      setTelefon(prospect.telefon || "");
      setEmail(prospect.email || "");
      setStrasse(prospect.strasse || "");
      setNr(prospect.nr || "");
      setPlz(prospect.plz || "");
      setStadt(prospect.stadt || "");
      if (prospect.pflegegrad) setPflegegrad(prospect.pflegegrad.toString());
    }
  }, [prospect]);

  useEffect(() => {
    if (openOffer?.wizardData && !offerHydrated.current) {
      offerHydrated.current = true;
      const wd = openOffer.wizardData as Record<string, string>;
      if (wd.billingType) setBillingType(wd.billingType);
      if (wd.vorname) setVorname(wd.vorname);
      if (wd.nachname) setNachname(wd.nachname);
      if (wd.geburtsdatum) setGeburtsdatum(wd.geburtsdatum);
      if (wd.email) setEmail(wd.email);
      if (wd.telefon) setTelefon(wd.telefon);
      if (wd.festnetz) setFestnetz(wd.festnetz);
      if (wd.strasse) setStrasse(wd.strasse);
      if (wd.nr) setNr(wd.nr);
      if (wd.plz) setPlz(wd.plz);
      if (wd.stadt) setStadt(wd.stadt);
      if (wd.pflegegrad) setPflegegrad(String(wd.pflegegrad));
      if (wd.pflegegradSeit) setPflegegradSeit(wd.pflegegradSeit);
      if (wd.vorerkrankungen) setVorerkrankungen(wd.vorerkrankungen);
      if (wd.contractStart) setContractStart(wd.contractStart);
      if (wd.contractHours) setContractHours(String(wd.contractHours));
      if (wd.contractPeriod) setContractPeriod(wd.contractPeriod);
      if (wd.vereinbarteLeistungen) setVereinbarteLeistungen(wd.vereinbarteLeistungen);
      if (wd.acceptsPrivatePayment !== undefined) setAcceptsPrivatePayment(Boolean(wd.acceptsPrivatePayment));
      if (wd.documentDeliveryMethod) setDocumentDeliveryMethod(wd.documentDeliveryMethod);
      if (wd.insuranceProviderId) setInsuranceProviderId(String(wd.insuranceProviderId));
      if (wd.versichertennummer) setVersichertennummer(wd.versichertennummer);
      if (wd.entlastungsbetrag45b) setEntlastungsbetrag45b(String(wd.entlastungsbetrag45b));
      if (wd.verhinderungspflege39) setVerhinderungspflege39(String(wd.verhinderungspflege39));
      if (wd.pflegesachleistungen36) setPflegesachleistungen36(String(wd.pflegesachleistungen36));
      if (wd.contactType) setContactType(wd.contactType);
      if (wd.contactVorname) setContactVorname(wd.contactVorname);
      if (wd.contactNachname) setContactNachname(wd.contactNachname);
      if (wd.contactFestnetz) setContactFestnetz(wd.contactFestnetz);
      if (wd.contactMobilnummer) setContactMobilnummer(wd.contactMobilnummer);
      if (wd.contactEmail) setContactEmail(wd.contactEmail);
      if (wd.primaryEmployeeId) setPrimaryEmployeeId(String(wd.primaryEmployeeId));
      if (wd.backupEmployeeId) setBackupEmployeeId(String(wd.backupEmployeeId));
      if (wd.contractDate) setContractDate(wd.contractDate);
    }
  }, [openOffer]);

  const buildPayload = () => ({
    billingType,
    vorname,
    nachname,
    geburtsdatum: geburtsdatum || null,
    email: email || null,
    telefon: telefon || null,
    festnetz: festnetz || null,
    strasse,
    nr,
    plz,
    stadt,
    pflegegrad: pflegegrad ? parseInt(pflegegrad) : undefined,
    pflegegradSeit: pflegegradSeit || undefined,
    vorerkrankungen: vorerkrankungen || null,
    acceptsPrivatePayment,
    documentDeliveryMethod,
    insurance: insuranceProviderId ? {
      providerId: parseInt(insuranceProviderId),
      versichertennummer,
      validFrom: contractStart,
    } : undefined,
    contacts: contactVorname ? [{
      contactType,
      isPrimary: true,
      vorname: contactVorname,
      nachname: contactNachname,
      festnetz: contactFestnetz || undefined,
      mobilnummer: contactMobilnummer || undefined,
      email: contactEmail || undefined,
    }] : undefined,
    budgets: {
      entlastungsbetrag45b: parseInt(entlastungsbetrag45b) || 0,
      verhinderungspflege39: parseInt(verhinderungspflege39) || 0,
      pflegesachleistungen36: parseInt(pflegesachleistungen36) || 0,
      validFrom: contractStart,
    },
    contract: {
      contractStart,
      contractDate: contractDate || undefined,
      vereinbarteLeistungen: vereinbarteLeistungen || undefined,
      hoursPerPeriod: parseFloat(contractHours) || 0,
      periodType: contractPeriod,
    },
    primaryEmployeeId: primaryEmployeeId ? parseInt(primaryEmployeeId) : null,
    backupEmployeeId: backupEmployeeId ? parseInt(backupEmployeeId) : null,
  });

  const convertMutation = useMutation({
    mutationFn: async (opts?: { skipDuplicateCheck?: boolean }) => {
      const payload = { ...buildPayload(), skipDuplicateCheck: opts?.skipDuplicateCheck ?? false };
      const result = await api.post(`/admin/prospects/${prospectId}/convert`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects", "customers");
      toast({ title: "Vertrag abgeschlossen", description: "Der Interessent wurde erfolgreich zum Kunden konvertiert." });
      setLocation("/admin/prospects");
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === "DUPLICATE_WARNING") {
        const dups = (error.details?.duplicates as Array<{ id: number; vorname: string; nachname: string; geburtsdatum: string | null; stadt: string | null; strasse: string | null; nr: string | null; status: string | null }> | undefined) || [];
        if (dups.length > 0) {
          setDuplicateWarning({ duplicates: dups });
          return;
        }
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const buildFlatWizardData = () => ({
    billingType,
    vorname,
    nachname,
    geburtsdatum,
    email,
    telefon,
    festnetz,
    strasse,
    nr,
    plz,
    stadt,
    pflegegrad,
    pflegegradSeit,
    vorerkrankungen,
    acceptsPrivatePayment,
    documentDeliveryMethod,
    insuranceProviderId,
    versichertennummer,
    contractStart,
    contractDate,
    vereinbarteLeistungen,
    contractHours,
    contractPeriod,
    entlastungsbetrag45b,
    verhinderungspflege39,
    pflegesachleistungen36,
    contactType,
    contactVorname,
    contactNachname,
    contactFestnetz,
    contactMobilnummer,
    contactEmail,
    primaryEmployeeId,
    backupEmployeeId,
  });

  const saveOfferMutation = useMutation({
    mutationFn: async () => {
      const wizardData = buildFlatWizardData();
      const result = await api.post(`/admin/prospects/${prospectId}/offers`, { wizardData });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
      queryClient.invalidateQueries({ queryKey: ["prospect-offer", prospectId] });
      toast({ title: "Angebot gespeichert", description: "Das Angebot wurde für den Interessenten gespeichert." });
      setLocation("/admin/prospects");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const employeeOptions = useMemo(() =>
    employees
      .filter((e) => e.isActive)
      .map((e) => ({ value: e.id.toString(), label: e.displayName }))
      .sort((a, b) => a.label.localeCompare(b.label, "de")),
    [employees]
  );

  const insuranceOptions = useMemo(() =>
    insuranceProviders.map((p) => ({ value: p.id.toString(), label: p.ikNummer ? `${p.name} (${p.ikNummer})` : `${p.name}${p.isPrivate ? " (Privat)" : ""}` }))
      .sort((a, b) => a.label.localeCompare(b.label, "de")),
    [insuranceProviders]
  );

  const isPending = convertMutation.isPending || saveOfferMutation.isPending;

  if (prospectLoading) {
    return (
      <Layout variant="admin">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        </div>
      </Layout>
    );
  }

  if (!prospect) {
    return (
      <Layout variant="admin">
        <div className="text-center py-12 text-muted-foreground">
          <p>Interessent nicht gefunden.</p>
          <Button variant="outline" className="mt-4" onClick={() => setLocation("/admin/prospects")}>
            Zurück zur Übersicht
          </Button>
        </div>
      </Layout>
    );
  }

  const canGoNext = () => {
    if (currentStep === 0) return !!billingType;
    if (currentStep === 1) return !!vorname && !!nachname && !!strasse && !!nr && !!plz && !!stadt;
    return true;
  };

  return (
    <Layout variant="admin">
      <DuplicateDialog
        duplicateWarning={duplicateWarning}
        onContinue={() => {
          setDuplicateWarning(null);
          convertMutation.mutate({ skipDuplicateCheck: true });
        }}
        onCancel={() => setDuplicateWarning(null)}
      />
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/admin/prospects")} aria-label="Zurück" data-testid="button-back">
          <ArrowLeft className={iconSize.md} />
        </Button>
        <div>
          <h1 className={componentStyles.pageTitle}>Vertrag erstellen</h1>
          <p className="text-sm text-muted-foreground">
            {prospect.vorname} {prospect.nachname}
            {openOffer && <Badge variant="outline" className="ml-2 text-xs">Offenes Angebot vorhanden</Badge>}
          </p>
        </div>
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3 justify-center">
          <span className="text-sm font-semibold text-teal-700">
            {STEPS[currentStep].title}
          </span>
          <span className="text-xs text-gray-500">
            ({currentStep + 1}/{STEPS.length})
          </span>
        </div>
        <div className="flex items-center justify-center gap-2">
          {STEPS.map((step, index) => (
            <div
              key={step.id}
              className={`rounded-full transition-all ${
                index === currentStep ? "w-8 h-2 bg-teal-600" : index < currentStep ? "w-2 h-2 bg-teal-600" : "w-2 h-2 bg-gray-300"
              }`}
              title={step.title}
            />
          ))}
        </div>
      </div>

      <Card className="bg-white mb-6">
        <CardContent className="p-6">
          {currentStep === 0 && (
            <div className="space-y-4" data-testid="step-billing-type">
              <h2 className="text-lg font-semibold">Abrechnungsart wählen</h2>
              <div className="grid gap-3">
                {BILLING_TYPE_SELECT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setBillingType(opt.value)}
                    className={`p-4 rounded-lg border-2 text-left transition-colors ${
                      billingType === opt.value ? "border-teal-600 bg-teal-50" : "border-gray-200 hover:border-gray-300"
                    }`}
                    data-testid={`billing-type-${opt.value}`}
                  >
                    <span className="font-medium">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-4" data-testid="step-personal-data">
              <h2 className="text-lg font-semibold">Persönliche Daten</h2>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Vorname *</Label>
                  <Input value={vorname} onChange={(e) => setVorname(e.target.value)} data-testid="input-vorname" />
                </div>
                <div>
                  <Label>Nachname *</Label>
                  <Input value={nachname} onChange={(e) => setNachname(e.target.value)} data-testid="input-nachname" />
                </div>
              </div>
              <div>
                <Label>Geburtsdatum</Label>
                <Input type="date" value={geburtsdatum} onChange={(e) => setGeburtsdatum(e.target.value)} data-testid="input-geburtsdatum" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Telefon</Label>
                  <Input value={telefon} onChange={(e) => setTelefon(e.target.value)} data-testid="input-telefon" />
                </div>
                <div>
                  <Label>Festnetz</Label>
                  <Input value={festnetz} onChange={(e) => setFestnetz(e.target.value)} data-testid="input-festnetz" />
                </div>
              </div>
              <div>
                <Label>E-Mail</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-email" />
              </div>
              <div className="grid grid-cols-[1fr_80px] gap-3">
                <div>
                  <Label>Straße *</Label>
                  <AddressAutocomplete
                    value={strasse}
                    onChange={(val) => setStrasse(val)}
                    onAddressSelect={(addr) => {
                      setStrasse(addr.strasse);
                      setNr(addr.hausnummer);
                      setPlz(addr.plz);
                      setStadt(addr.stadt);
                    }}
                    data-testid="input-strasse"
                  />
                </div>
                <div>
                  <Label>Nr. *</Label>
                  <Input value={nr} onChange={(e) => setNr(e.target.value)} data-testid="input-nr" />
                </div>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-3">
                <div>
                  <Label>PLZ *</Label>
                  <Input value={plz} onChange={(e) => setPlz(e.target.value.replace(/\D/g, "").slice(0, 5))} maxLength={5} inputMode="numeric" data-testid="input-plz" />
                </div>
                <div>
                  <Label>Stadt *</Label>
                  <Input value={stadt} onChange={(e) => setStadt(e.target.value)} data-testid="input-stadt" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Pflegegrad</Label>
                  <Select value={pflegegrad || "0"} onValueChange={setPflegegrad}>
                    <SelectTrigger data-testid="select-pflegegrad">
                      <SelectValue placeholder="Kein Pflegegrad" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Kein Pflegegrad</SelectItem>
                      {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Pflegegrad seit</Label>
                  <Input type="date" value={pflegegradSeit} onChange={(e) => setPflegegradSeit(e.target.value)} data-testid="input-pflegegrad-seit" />
                </div>
              </div>
              <div>
                <Label>Vorerkrankungen</Label>
                <Textarea value={vorerkrankungen} onChange={(e) => setVorerkrankungen(e.target.value)} data-testid="input-vorerkrankungen" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="accepts-private" checked={acceptsPrivatePayment} onChange={(e) => setAcceptsPrivatePayment(e.target.checked)} data-testid="checkbox-accepts-private" />
                <Label htmlFor="accepts-private">Akzeptiert private Zuzahlung</Label>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-4" data-testid="step-contract">
              <h2 className="text-lg font-semibold">Vertragsdaten</h2>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Vertragsbeginn</Label>
                  <Input type="date" value={contractStart} onChange={(e) => setContractStart(e.target.value)} data-testid="input-contract-start" />
                </div>
                <div>
                  <Label>Vertragsdatum</Label>
                  <Input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} data-testid="input-contract-date" />
                </div>
              </div>
              <div>
                <Label>Vereinbarte Leistungen</Label>
                <Textarea value={vereinbarteLeistungen} onChange={(e) => setVereinbarteLeistungen(e.target.value)} placeholder="z.B. Hauswirtschaft, Alltagsbegleitung..." data-testid="input-vereinbarte-leistungen" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Stunden pro Zeitraum</Label>
                  <Input type="number" value={contractHours} onChange={(e) => setContractHours(e.target.value)} data-testid="input-contract-hours" />
                </div>
                <div>
                  <Label>Zeitraum</Label>
                  <Select value={contractPeriod} onValueChange={setContractPeriod}>
                    <SelectTrigger data-testid="select-contract-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Wöchentlich</SelectItem>
                      <SelectItem value="biweekly">Alle 2 Wochen</SelectItem>
                      <SelectItem value="monthly">Monatlich</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {billingType && billingType !== "selbstzahler" && (
                <div className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-medium">Versicherung</h3>
                  <div>
                    <Label>Kostenträger</Label>
                    <SearchableSelect
                      options={insuranceOptions}
                      value={insuranceProviderId}
                      onValueChange={setInsuranceProviderId}
                      placeholder="Kostenträger auswählen..."
                      searchPlaceholder="Suchen..."
                      emptyText="Kein Kostenträger gefunden."
                      data-testid="select-insurance-provider"
                    />
                  </div>
                  <div>
                    <Label>Versichertennummer</Label>
                    <Input value={versichertennummer} onChange={(e) => setVersichertennummer(e.target.value)} data-testid="input-versichertennummer" />
                  </div>
                </div>
              )}
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-4" data-testid="step-budgets">
              <h2 className="text-lg font-semibold">Budgets (Cent-Beträge)</h2>
              <div>
                <Label>Entlastungsbetrag § 45b (jährlich, Cent)</Label>
                <Input type="number" value={entlastungsbetrag45b} onChange={(e) => setEntlastungsbetrag45b(e.target.value)} data-testid="input-budget-45b" />
                <p className="text-xs text-muted-foreground mt-1">Standard: 15.600 Cent (156 €/Monat)</p>
              </div>
              <div>
                <Label>Verhinderungspflege § 39 (jährlich, Cent)</Label>
                <Input type="number" value={verhinderungspflege39} onChange={(e) => setVerhinderungspflege39(e.target.value)} data-testid="input-budget-39" />
              </div>
              <div>
                <Label>Pflegesachleistungen § 36 (monatlich, Cent)</Label>
                <Input type="number" value={pflegesachleistungen36} onChange={(e) => setPflegesachleistungen36(e.target.value)} data-testid="input-budget-36" />
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-6" data-testid="step-contacts-signatures">
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Ansprechpartner</h2>
                <div>
                  <Label>Kontaktart</Label>
                  <Select value={contactType} onValueChange={setContactType}>
                    <SelectTrigger data-testid="select-contact-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_TYPE_SELECT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Vorname</Label>
                    <Input value={contactVorname} onChange={(e) => setContactVorname(e.target.value)} data-testid="input-contact-vorname" />
                  </div>
                  <div>
                    <Label>Nachname</Label>
                    <Input value={contactNachname} onChange={(e) => setContactNachname(e.target.value)} data-testid="input-contact-nachname" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Festnetz</Label>
                    <Input value={contactFestnetz} onChange={(e) => setContactFestnetz(e.target.value)} placeholder="09121 12345" data-testid="input-contact-festnetz" />
                  </div>
                  <div>
                    <Label>Mobilnummer</Label>
                    <Input value={contactMobilnummer} onChange={(e) => setContactMobilnummer(e.target.value)} placeholder="0170 1234567" data-testid="input-contact-mobilnummer" />
                  </div>
                </div>
                <div>
                  <Label>E-Mail</Label>
                  <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} data-testid="input-contact-email" />
                </div>
              </div>

              <div className="border-t pt-4 space-y-4">
                <h2 className="text-lg font-semibold">Unterschriften & Versand</h2>
                <div>
                  <Label>Dokumentenversand</Label>
                  <Select value={documentDeliveryMethod} onValueChange={setDocumentDeliveryMethod}>
                    <SelectTrigger data-testid="select-document-delivery">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">Per E-Mail</SelectItem>
                      <SelectItem value="post">Per Post</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800" data-testid="info-signatures">
                  <p className="font-medium">Hinweis zu Unterschriften</p>
                  <p className="mt-1">
                    Vertragsunterschriften und Pflichtdokumente können nach der Kundenanlage 
                    in der Kundendetailansicht unter „Dokumente" digital erfasst werden.
                  </p>
                </div>
              </div>
            </div>
          )}

          {currentStep === 5 && (
            <div className="space-y-4" data-testid="step-employees">
              <h2 className="text-lg font-semibold">Mitarbeiter zuweisen</h2>
              <div>
                <Label>Hauptbetreuer</Label>
                <SearchableSelect
                  options={employeeOptions}
                  value={primaryEmployeeId}
                  onValueChange={setPrimaryEmployeeId}
                  placeholder="Mitarbeiter auswählen..."
                  searchPlaceholder="Suchen..."
                  emptyText="Kein Mitarbeiter gefunden."
                  data-testid="select-primary-employee"
                />
              </div>
              <div>
                <Label>Vertretung</Label>
                <SearchableSelect
                  options={employeeOptions}
                  value={backupEmployeeId}
                  onValueChange={setBackupEmployeeId}
                  placeholder="Vertretung auswählen..."
                  searchPlaceholder="Suchen..."
                  emptyText="Kein Mitarbeiter gefunden."
                  data-testid="select-backup-employee"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
          disabled={currentStep === 0}
          data-testid="button-prev-step"
        >
          <ChevronLeft className="h-4 w-4 mr-1" /> Zurück
        </Button>

        <div className="flex gap-2">
          {currentStep === STEPS.length - 1 ? (
            <>
              <Button
                variant="outline"
                onClick={() => saveOfferMutation.mutate()}
                disabled={isPending}
                data-testid="button-save-offer"
              >
                {saveOfferMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                Als Angebot speichern
              </Button>
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => convertMutation.mutate(undefined)}
                disabled={isPending}
                data-testid="button-convert"
              >
                {convertMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                Jetzt Vertrag abschließen
              </Button>
            </>
          ) : (
            <Button
              onClick={() => setCurrentStep(Math.min(STEPS.length - 1, currentStep + 1))}
              disabled={!canGoNext()}
              data-testid="button-next-step"
            >
              Weiter <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </div>
      </div>
    </Layout>
  );
}
