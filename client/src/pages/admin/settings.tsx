import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, Upload, Trash2, ImageIcon, Mail, Truck, CheckCircle2, XCircle, Eye, EyeOff, FileText, Smartphone, KeyRound, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import type { SystemSettings, CompanySettings } from "@shared/schema";

function BackfillBudgetCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<{ total: number; created: number; skipped: number; errors: number } | null>(null);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ total: number; created: number; skipped: number; errors: number }>("/admin/budget/backfill-transactions");
      return unwrapResult(res);
    },
    onSuccess: (data) => {
      setResult(data);
      toast({ title: `${data.created} Budget-Buchungen nachgetragen`, description: `${data.total} Termine geprüft, ${data.skipped} übersprungen, ${data.errors} Fehler` });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-backfill-budget">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className={iconSize.sm} />
          Wartung: Budget-Nachbuchung
        </CardTitle>
        <CardDescription>
          Importierte Termine, die keine Budget-Abbuchung haben, werden nachträglich gebucht.
          Betrifft abgeschlossene Termine ohne zugehörige Budget-Transaktion.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
          variant="outline"
          data-testid="button-backfill-budget"
        >
          {backfillMutation.isPending ? (
            <><Loader2 className={`${iconSize.sm} animate-spin mr-2`} />Wird verarbeitet...</>
          ) : (
            "Budget-Buchungen nachtragen"
          )}
        </Button>
        {result && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm space-y-1">
            <p><strong>{result.total}</strong> Termine ohne Budget-Buchung gefunden</p>
            <p className="text-green-700"><strong>{result.created}</strong> Buchungen erfolgreich erstellt</p>
            {result.skipped > 0 && <p className="text-gray-600"><strong>{result.skipped}</strong> übersprungen</p>}
            {result.errors > 0 && <p className="text-red-600"><strong>{result.errors}</strong> Fehler (z.B. fehlende Preisvereinbarungen)</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const BUNDESLAENDER = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
];

const emptyCompanyForm = {
  companyName: "",
  geschaeftsfuehrer: "",
  strasse: "",
  hausnummer: "",
  plz: "",
  stadt: "",
  telefon: "",
  email: "",
  website: "",
  steuernummer: "",
  ustId: "",
  iban: "",
  bic: "",
  bankName: "",
  ikNummer: "",
  anerkennungsnummer45a: "",
  anerkennungsBundesland: "",
  smtpHost: "",
  smtpPort: "",
  smtpUser: "",
  smtpPass: "",
  smtpFromEmail: "",
  smtpFromName: "",
  smtpSecure: false,
  epostVendorId: "",
  epostEkp: "",
  epostPassword: "",
  epostSecret: "",
  epostTestMode: true,
  deliveryEmailSubject: "",
  deliveryCoverLetterText: "",
};

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<SystemSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const result = await api.get<SystemSettings>("/settings");
      return unwrapResult(result);
    },
  });

  const { data: companyData, isLoading: isCompanyLoading } = useQuery<CompanySettings>({
    queryKey: ["company-settings"],
    queryFn: async () => {
      const result = await api.get<CompanySettings>("/company-settings");
      return unwrapResult(result);
    },
  });

  const [companyForm, setCompanyForm] = useState(emptyCompanyForm);

  useEffect(() => {
    if (companyData) {
      setCompanyForm({
        companyName: companyData.companyName ?? "",
        geschaeftsfuehrer: companyData.geschaeftsfuehrer ?? "",
        strasse: companyData.strasse ?? "",
        hausnummer: companyData.hausnummer ?? "",
        plz: companyData.plz ?? "",
        stadt: companyData.stadt ?? "",
        telefon: companyData.telefon ?? "",
        email: companyData.email ?? "",
        website: companyData.website ?? "",
        steuernummer: companyData.steuernummer ?? "",
        ustId: companyData.ustId ?? "",
        iban: companyData.iban ?? "",
        bic: companyData.bic ?? "",
        bankName: companyData.bankName ?? "",
        ikNummer: companyData.ikNummer ?? "",
        anerkennungsnummer45a: companyData.anerkennungsnummer45a ?? "",
        anerkennungsBundesland: companyData.anerkennungsBundesland ?? "",
        smtpHost: companyData.smtpHost ?? "",
        smtpPort: companyData.smtpPort ?? "",
        smtpUser: companyData.smtpUser ?? "",
        smtpPass: companyData.smtpPass ?? "",
        smtpFromEmail: companyData.smtpFromEmail ?? "",
        smtpFromName: companyData.smtpFromName ?? "",
        smtpSecure: companyData.smtpSecure ?? false,
        epostVendorId: companyData.epostVendorId ?? "",
        epostEkp: companyData.epostEkp ?? "",
        epostPassword: companyData.epostPassword ?? "",
        epostSecret: companyData.epostSecret ?? "",
        epostTestMode: companyData.epostTestMode ?? true,
        deliveryEmailSubject: companyData.deliveryEmailSubject ?? "",
        deliveryCoverLetterText: companyData.deliveryCoverLetterText ?? "",
      });
    }
  }, [companyData]);

  const updateField = (field: keyof typeof companyForm, value: string | boolean) => {
    setCompanyForm((prev) => ({ ...prev, [field]: value }));
  };

  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [showEpostPass, setShowEpostPass] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [epostTestResult, setEpostTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [epostActivationStep, setEpostActivationStep] = useState<"idle" | "sms_sent" | "setting_password">("idle");
  const [epostSmsCode, setEpostSmsCode] = useState("");
  const [epostNewPassword, setEpostNewPassword] = useState("");
  const [showEpostNewPass, setShowEpostNewPass] = useState(false);

  const companySaveMutation = useMutation({
    mutationFn: async (data: typeof companyForm) => {
      const result = await api.patch<CompanySettings>("/company-settings", data);
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Firmendaten gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const smtpTestMutation = useMutation({
    mutationFn: async () => {
      await companySaveMutation.mutateAsync(companyForm);
      const result = await api.post<{ success: boolean; error?: string }>("/admin/document-delivery/test-smtp", {});
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      setSmtpTestResult(data);
      toast({ title: data.success ? "SMTP-Verbindung erfolgreich" : "SMTP-Verbindung fehlgeschlagen", variant: data.success ? "default" : "destructive" });
    },
    onError: (error: Error) => {
      setSmtpTestResult({ success: false, error: error.message });
      toast({ title: "SMTP-Test fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const epostTestMutation = useMutation({
    mutationFn: async () => {
      await companySaveMutation.mutateAsync(companyForm);
      const result = await api.post<{ success: boolean; error?: string }>("/admin/document-delivery/test-epost", {});
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      setEpostTestResult(data);
      toast({ title: data.success ? "E-POST-Verbindung erfolgreich" : "E-POST-Verbindung fehlgeschlagen", variant: data.success ? "default" : "destructive" });
    },
    onError: (error: Error) => {
      setEpostTestResult({ success: false, error: error.message });
      toast({ title: "E-POST-Test fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const epostSmsRequestMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post<{ success: boolean; message?: string; error?: string }>("/admin/document-delivery/epost-sms-request", {
        vendorId: companyForm.epostVendorId,
        ekp: companyForm.epostEkp,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      if (data.success) {
        setEpostActivationStep("sms_sent");
        toast({ title: "SMS-Code angefordert", description: data.message || "Bitte prüfen Sie Ihr Mobiltelefon." });
      } else {
        toast({ title: "SMS-Anfrage fehlgeschlagen", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "SMS-Anfrage fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const epostSetPasswordMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post<{ success: boolean; secret?: string; error?: string }>("/admin/document-delivery/epost-set-password", {
        vendorId: companyForm.epostVendorId,
        ekp: companyForm.epostEkp,
        newPassword: epostNewPassword,
        smsCode: epostSmsCode,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      if (data.success && data.secret) {
        updateField("epostPassword", epostNewPassword);
        updateField("epostSecret", data.secret);
        setEpostActivationStep("idle");
        setEpostSmsCode("");
        setEpostNewPassword("");
        queryClient.invalidateQueries({ queryKey: ["company-settings"] });
        toast({ title: "E-POST aktiviert", description: "Passwort und Sicherheitsschlüssel wurden gespeichert." });
      } else {
        toast({ title: "Aktivierung fehlgeschlagen", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Aktivierung fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (autoBreaksEnabled: boolean) => {
      const result = await api.patch<SystemSettings>("/settings", { autoBreaksEnabled });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      toast({
        title: data.autoBreaksEnabled
          ? "Automatische Pausen aktiviert"
          : "Automatische Pausen deaktiviert",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const [minijobLimit, setMinijobLimit] = useState("");

  useEffect(() => {
    if (companyData?.minijobEarningsLimitCents != null) {
      setMinijobLimit(String(companyData.minijobEarningsLimitCents / 100));
    }
  }, [companyData?.minijobEarningsLimitCents]);

  const minijobLimitMutation = useMutation({
    mutationFn: async (limitEuro: string) => {
      const cents = Math.round(parseFloat(limitEuro) * 100);
      const result = await api.patch<CompanySettings>("/company-settings", { minijobEarningsLimitCents: cents });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Minijob-Verdienstgrenze gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const logoUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setLogoUploading(true);
      const uploadRes = await api.post<{ uploadURL: string; objectPath: string; metadata: { name: string } }>(
        "/uploads/request-url",
        { name: file.name, size: file.size, contentType: file.type }
      );
      const uploadData = unwrapResult(uploadRes);

      await fetch(uploadData.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      const result = await api.patch<CompanySettings>("/company-settings", {
        logoUrl: uploadData.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Logo hochgeladen" });
      setLogoUploading(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Logo-Upload", description: error.message, variant: "destructive" });
      setLogoUploading(false);
    },
  });

  const logoDeleteMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", { logoUrl: null });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Logo entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleLogoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Nur Bilddateien erlaubt", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Datei zu groß (max. 2 MB)", variant: "destructive" });
      return;
    }

    logoUploadMutation.mutate(file);
    e.target.value = "";
  };

  const loading = isLoading || isCompanyLoading;

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className={componentStyles.pageTitle}>Einstellungen</h1>
              <p className="text-gray-600">Systemweite Konfiguration</p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Card data-testid="card-company-logo">
                <CardHeader>
                  <CardTitle>Firmenlogo</CardTitle>
                  <CardDescription>
                    Wird im Header der Anwendung und auf Dokumenten angezeigt.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-6">
                    <div className="w-24 h-24 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                      {companyData?.logoUrl ? (
                        <img
                          src={companyData.logoUrl}
                          alt="Firmenlogo"
                          className="w-full h-full object-contain p-1"
                          data-testid="img-company-logo"
                        />
                      ) : (
                        <ImageIcon className="h-8 w-8 text-gray-400" />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp"
                        className="hidden"
                        onChange={handleLogoSelect}
                        data-testid="input-logo-file"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={logoUploading}
                        onClick={() => fileInputRef.current?.click()}
                        data-testid="button-upload-logo"
                      >
                        {logoUploading ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Upload className="mr-2 h-4 w-4" />
                        )}
                        {companyData?.logoUrl ? "Logo ändern" : "Logo hochladen"}
                      </Button>
                      {companyData?.logoUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={logoDeleteMutation.isPending}
                          onClick={() => logoDeleteMutation.mutate()}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 justify-start"
                          data-testid="button-delete-logo"
                        >
                          {logoDeleteMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="mr-2 h-4 w-4" />
                          )}
                          Logo entfernen
                        </Button>
                      )}
                      <p className="text-xs text-gray-500">
                        PNG, JPG, SVG oder WebP. Max. 2 MB.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-company-settings">
                <CardHeader>
                  <CardTitle>Firmenstammdaten</CardTitle>
                  <CardDescription>
                    Diese Daten werden auf Rechnungen und Leistungsnachweisen verwendet.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      companySaveMutation.mutate(companyForm);
                    }}
                    className="flex flex-col gap-6"
                  >
                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Firma</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="companyName">Firmenname</Label>
                          <Input
                            id="companyName"
                            data-testid="input-company-companyName"
                            value={companyForm.companyName}
                            onChange={(e) => updateField("companyName", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="geschaeftsfuehrer">Geschäftsführer</Label>
                          <Input
                            id="geschaeftsfuehrer"
                            data-testid="input-company-geschaeftsfuehrer"
                            value={companyForm.geschaeftsfuehrer}
                            onChange={(e) => updateField("geschaeftsfuehrer", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Adresse</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="strasse">Straße</Label>
                          <Input
                            id="strasse"
                            data-testid="input-company-strasse"
                            value={companyForm.strasse}
                            onChange={(e) => updateField("strasse", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="hausnummer">Hausnummer</Label>
                          <Input
                            id="hausnummer"
                            data-testid="input-company-hausnummer"
                            value={companyForm.hausnummer}
                            onChange={(e) => updateField("hausnummer", e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="plz">PLZ</Label>
                          <Input
                            id="plz"
                            data-testid="input-company-plz"
                            value={companyForm.plz}
                            onChange={(e) => updateField("plz", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="stadt">Stadt</Label>
                          <Input
                            id="stadt"
                            data-testid="input-company-stadt"
                            value={companyForm.stadt}
                            onChange={(e) => updateField("stadt", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Kontakt</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="telefon">Telefon</Label>
                          <Input
                            id="telefon"
                            data-testid="input-company-telefon"
                            value={companyForm.telefon}
                            onChange={(e) => updateField("telefon", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="email">E-Mail</Label>
                          <Input
                            id="email"
                            data-testid="input-company-email"
                            value={companyForm.email}
                            onChange={(e) => updateField("email", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="website">Website</Label>
                          <Input
                            id="website"
                            data-testid="input-company-website"
                            value={companyForm.website}
                            onChange={(e) => updateField("website", e.target.value)}
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Steuerdaten</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="steuernummer">Steuernummer</Label>
                          <Input
                            id="steuernummer"
                            data-testid="input-company-steuernummer"
                            value={companyForm.steuernummer}
                            onChange={(e) => updateField("steuernummer", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="ustId">USt-ID</Label>
                          <Input
                            id="ustId"
                            data-testid="input-company-ustId"
                            value={companyForm.ustId}
                            onChange={(e) => updateField("ustId", e.target.value)}
                            placeholder="Optional"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Entfällt bei Steuerbefreiung nach §4 Nr. 16 UStG
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Bankverbindung</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="iban">IBAN</Label>
                          <Input
                            id="iban"
                            data-testid="input-company-iban"
                            value={companyForm.iban}
                            onChange={(e) => updateField("iban", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="bic">BIC</Label>
                          <Input
                            id="bic"
                            data-testid="input-company-bic"
                            value={companyForm.bic}
                            onChange={(e) => updateField("bic", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="bankName">Bank</Label>
                          <Input
                            id="bankName"
                            data-testid="input-company-bankName"
                            value={companyForm.bankName}
                            onChange={(e) => updateField("bankName", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Anerkennung</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="ikNummer">IK-Nummer</Label>
                          <Input
                            id="ikNummer"
                            data-testid="input-company-ikNummer"
                            value={companyForm.ikNummer}
                            onChange={(e) => updateField("ikNummer", e.target.value)}
                            placeholder="9 Ziffern, Institutionskennzeichen"
                          />
                        </div>
                        <div>
                          <Label htmlFor="anerkennungsnummer45a">Anerkennungsnummer (§45a)</Label>
                          <Input
                            id="anerkennungsnummer45a"
                            data-testid="input-company-anerkennungsnummer45a"
                            value={companyForm.anerkennungsnummer45a}
                            onChange={(e) => updateField("anerkennungsnummer45a", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="anerkennungsBundesland">Bundesland der Anerkennung</Label>
                          <Select
                            value={companyForm.anerkennungsBundesland}
                            onValueChange={(value) => updateField("anerkennungsBundesland", value)}
                          >
                            <SelectTrigger data-testid="select-company-bundesland" id="anerkennungsBundesland">
                              <SelectValue placeholder="Bundesland wählen" />
                            </SelectTrigger>
                            <SelectContent>
                              {BUNDESLAENDER.map((bl) => (
                                <SelectItem key={bl} value={bl}>
                                  {bl}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        data-testid="button-save-company"
                        disabled={companySaveMutation.isPending}
                      >
                        {companySaveMutation.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Speichern
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>


              <Card data-testid="card-smtp-settings">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mail className="h-5 w-5 text-teal-600" />
                    E-Mail-Versand (SMTP)
                  </CardTitle>
                  <CardDescription>
                    SMTP-Server-Konfiguration für den automatischen E-Mail-Versand von Vertragsunterlagen an Kunden.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="smtpHost">SMTP-Server</Label>
                        <Input
                          id="smtpHost"
                          value={companyForm.smtpHost}
                          onChange={(e) => updateField("smtpHost", e.target.value)}
                          placeholder="z.B. smtp.office365.com"
                          data-testid="input-smtp-host"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="smtpPort">Port</Label>
                        <Input
                          id="smtpPort"
                          value={companyForm.smtpPort}
                          onChange={(e) => updateField("smtpPort", e.target.value)}
                          placeholder="587"
                          data-testid="input-smtp-port"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="smtpUser">Benutzername</Label>
                        <Input
                          id="smtpUser"
                          value={companyForm.smtpUser}
                          onChange={(e) => updateField("smtpUser", e.target.value)}
                          placeholder="user@example.com"
                          data-testid="input-smtp-user"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="smtpPass">Passwort</Label>
                        <div className="relative">
                          <Input
                            id="smtpPass"
                            type={showSmtpPass ? "text" : "password"}
                            value={companyForm.smtpPass}
                            onChange={(e) => updateField("smtpPass", e.target.value)}
                            placeholder="••••••••"
                            data-testid="input-smtp-pass"
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            onClick={() => setShowSmtpPass(!showSmtpPass)}
                          >
                            {showSmtpPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="smtpFromEmail">Absender E-Mail</Label>
                        <Input
                          id="smtpFromEmail"
                          value={companyForm.smtpFromEmail}
                          onChange={(e) => updateField("smtpFromEmail", e.target.value)}
                          placeholder="info@firma.de"
                          data-testid="input-smtp-from-email"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="smtpFromName">Absender Name</Label>
                        <Input
                          id="smtpFromName"
                          value={companyForm.smtpFromName}
                          onChange={(e) => updateField("smtpFromName", e.target.value)}
                          placeholder="Firmenname"
                          data-testid="input-smtp-from-name"
                        />
                      </div>
                    </div>
                    <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
                      <p className="text-xs text-blue-700">Port 465 → automatisch SSL/TLS. Port 587 → automatisch STARTTLS. Die Verschlüsselung wird anhand des Ports erkannt.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={smtpTestMutation.isPending || !companyForm.smtpHost}
                        onClick={() => smtpTestMutation.mutate()}
                        data-testid="button-test-smtp"
                      >
                        {smtpTestMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                        Verbindung testen
                      </Button>
                      {smtpTestResult && (
                        <div className={`flex items-center gap-1.5 text-sm ${smtpTestResult.success ? "text-green-600" : "text-red-600"}`}>
                          {smtpTestResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                          {smtpTestResult.success ? "Verbindung OK" : smtpTestResult.error}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Einstellungen werden beim Speichern der Firmendaten mit gespeichert.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-epost-settings">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Truck className="h-5 w-5 text-amber-600" />
                    Deutsche Post E-POST Mailer
                  </CardTitle>
                  <CardDescription>
                    API-Zugangsdaten für den automatischen Briefversand über den E-POST Mailer der Deutschen Post.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="epostVendorId">Vendor-ID</Label>
                        <Input
                          id="epostVendorId"
                          value={companyForm.epostVendorId}
                          onChange={(e) => updateField("epostVendorId", e.target.value)}
                          placeholder="Vendor-ID"
                          data-testid="input-epost-vendor-id"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="epostEkp">EKP (Kundennummer)</Label>
                        <Input
                          id="epostEkp"
                          value={companyForm.epostEkp}
                          onChange={(e) => updateField("epostEkp", e.target.value)}
                          placeholder="10-stellige Kundennummer"
                          data-testid="input-epost-ekp"
                        />
                      </div>
                    </div>

                    {companyForm.epostSecret ? (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label htmlFor="epostPassword">Passwort</Label>
                            <div className="relative">
                              <Input
                                id="epostPassword"
                                type={showEpostPass ? "text" : "password"}
                                value={companyForm.epostPassword}
                                onChange={(e) => updateField("epostPassword", e.target.value)}
                                placeholder="••••••••"
                                data-testid="input-epost-password"
                              />
                              <button
                                type="button"
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                onClick={() => setShowEpostPass(!showEpostPass)}
                              >
                                {showEpostPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                              </button>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="epostSecret">Sicherheitsschlüssel (Secret)</Label>
                            <Input
                              id="epostSecret"
                              value={companyForm.epostSecret}
                              placeholder="Wird bei Aktivierung vergeben"
                              data-testid="input-epost-secret"
                              readOnly
                              className="bg-muted"
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label htmlFor="epostTestMode">Testmodus</Label>
                            <p className="text-xs text-muted-foreground">Im Testmodus werden Briefe nicht gedruckt/versendet. Für Produktivbetrieb deaktivieren.</p>
                          </div>
                          <Switch
                            id="epostTestMode"
                            checked={companyForm.epostTestMode}
                            onCheckedChange={(checked) => updateField("epostTestMode", checked)}
                            data-testid="switch-epost-test-mode"
                          />
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={epostTestMutation.isPending || !companyForm.epostVendorId}
                            onClick={() => epostTestMutation.mutate()}
                            data-testid="button-test-epost"
                          >
                            {epostTestMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                            Verbindung testen
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              updateField("epostSecret", "");
                              updateField("epostPassword", "");
                              setEpostActivationStep("idle");
                            }}
                            data-testid="button-epost-reactivate"
                          >
                            <KeyRound className="mr-2 h-4 w-4" />
                            Neu aktivieren
                          </Button>
                          {epostTestResult && (
                            <div className={`flex items-center gap-1.5 text-sm ${epostTestResult.success ? "text-green-600" : "text-red-600"}`}>
                              {epostTestResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                              {epostTestResult.success ? "Verbindung OK" : epostTestResult.error}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-4">
                        <div className="flex items-start gap-3">
                          <Smartphone className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                          <div className="space-y-1">
                            <p className="font-medium text-sm">API-Zugang aktivieren</p>
                            <p className="text-xs text-muted-foreground">
                              Um die E-POST-Schnittstelle zu nutzen, muss ein Passwort über SMS-Verifizierung gesetzt werden. 
                              Dabei erhalten Sie automatisch den Sicherheitsschlüssel (Secret).
                            </p>
                          </div>
                        </div>

                        {epostActivationStep === "idle" && (
                          <div className="space-y-3">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={epostSmsRequestMutation.isPending || !companyForm.epostVendorId || !companyForm.epostEkp || companyForm.epostEkp.length !== 10}
                              onClick={() => epostSmsRequestMutation.mutate()}
                              data-testid="button-epost-sms-request"
                            >
                              {epostSmsRequestMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}
                              SMS-Code anfordern
                            </Button>
                            {(!companyForm.epostVendorId || !companyForm.epostEkp) && (
                              <p className="text-xs text-muted-foreground">Bitte zuerst Vendor-ID und EKP eintragen.</p>
                            )}
                          </div>
                        )}

                        {epostActivationStep === "sms_sent" && (
                          <div className="space-y-3">
                            <p className="text-sm text-green-700 font-medium">SMS-Code wurde gesendet. Bitte Mobiltelefon prüfen.</p>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-2">
                                <Label htmlFor="epostSmsCode">SMS-Code (6 Ziffern)</Label>
                                <Input
                                  id="epostSmsCode"
                                  value={epostSmsCode}
                                  onChange={(e) => setEpostSmsCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                  placeholder="123456"
                                  maxLength={6}
                                  data-testid="input-epost-sms-code"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="epostNewPassword">Neues Passwort (min. 5 Zeichen)</Label>
                                <div className="relative">
                                  <Input
                                    id="epostNewPassword"
                                    type={showEpostNewPass ? "text" : "password"}
                                    value={epostNewPassword}
                                    onChange={(e) => setEpostNewPassword(e.target.value)}
                                    placeholder="Passwort wählen"
                                    data-testid="input-epost-new-password"
                                  />
                                  <button
                                    type="button"
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                    onClick={() => setShowEpostNewPass(!showEpostNewPass)}
                                  >
                                    {showEpostNewPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                  </button>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={epostSetPasswordMutation.isPending || epostSmsCode.length !== 6 || epostNewPassword.length < 5}
                                onClick={() => epostSetPasswordMutation.mutate()}
                                data-testid="button-epost-activate"
                              >
                                {epostSetPasswordMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                                Aktivieren
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEpostActivationStep("idle");
                                  setEpostSmsCode("");
                                  setEpostNewPassword("");
                                }}
                              >
                                Abbrechen
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Einstellungen werden beim Speichern der Firmendaten mit gespeichert.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-cover-letter-settings">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5 text-indigo-600" />
                    Anschreiben (E-Mail & Brief)
                  </CardTitle>
                  <CardDescription>
                    Betreff und Anschreibentext für den Dokumentenversand an Kunden. Wird für E-Mail und Postversand verwendet.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="deliveryEmailSubject">E-Mail-Betreff</Label>
                      <Input
                        id="deliveryEmailSubject"
                        value={companyForm.deliveryEmailSubject}
                        onChange={(e) => updateField("deliveryEmailSubject", e.target.value)}
                        placeholder="Ihre Vertragsunterlagen — {{firmenname}}"
                        data-testid="input-delivery-email-subject"
                      />
                      <p className="text-xs text-muted-foreground">{"Standard: \"Ihre Vertragsunterlagen — {{firmenname}}\""}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="deliveryCoverLetterText">Anschreiben-Text</Label>
                      <Textarea
                        id="deliveryCoverLetterText"
                        value={companyForm.deliveryCoverLetterText}
                        onChange={(e) => updateField("deliveryCoverLetterText", e.target.value)}
                        placeholder={"Sehr geehrte/r {{kundenname}},\n\nanbei erhalten Sie Ihre unterschriebenen Vertragsunterlagen:\n\n{{dokumentenliste}}\n\nBitte bewahren Sie diese Unterlagen sorgfältig auf.\n\nMit freundlichen Grüßen\n{{firmenname}}"}
                        rows={10}
                        className="font-mono text-sm"
                        data-testid="textarea-delivery-cover-letter"
                      />
                    </div>
                    <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                      <p className="font-medium mb-2">Verfügbare Platzhalter:</p>
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        <div><code className="bg-white px-1 rounded">{"{{kundenname}}"}</code> — Vollständiger Kundenname</div>
                        <div><code className="bg-white px-1 rounded">{"{{vorname}}"}</code> — Vorname des Kunden</div>
                        <div><code className="bg-white px-1 rounded">{"{{nachname}}"}</code> — Nachname des Kunden</div>
                        <div><code className="bg-white px-1 rounded">{"{{firmenname}}"}</code> — Name Ihres Unternehmens</div>
                        <div><code className="bg-white px-1 rounded">{"{{datum}}"}</code> — Heutiges Datum</div>
                        <div><code className="bg-white px-1 rounded">{"{{dokumentenliste}}"}</code> — Liste der Dokumente</div>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Leer lassen für den Standardtext. Speichern über den Button "Speichern" bei den Firmendaten oben.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-minijob-limit">
                <CardHeader>
                  <CardTitle>Minijob-Verdienstgrenze</CardTitle>
                  <CardDescription>
                    Monatliche Verdienstgrenze für Minijobber. Überschüssige Stunden werden automatisch
                    in den Folgemonat übertragen (sichtbar in der Stundenübersicht).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-4">
                    <div className="space-y-1 flex-1 max-w-[200px]">
                      <Label htmlFor="minijob-limit">Grenze (€ / Monat)</Label>
                      <Input
                        id="minijob-limit"
                        data-testid="input-minijob-limit"
                        type="number"
                        step="0.01"
                        min="0"
                        value={minijobLimit}
                        onChange={(e) => setMinijobLimit(e.target.value)}
                      />
                    </div>
                    <Button
                      data-testid="button-save-minijob-limit"
                      size="sm"
                      disabled={minijobLimitMutation.isPending || !minijobLimit}
                      onClick={() => minijobLimitMutation.mutate(minijobLimit)}
                    >
                      Speichern
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-auto-breaks">
                <CardHeader>
                  <CardTitle>Automatische Pausen</CardTitle>
                  <CardDescription>
                    Beim Monatsabschluss werden fehlende Pausen automatisch ergänzt,
                    basierend auf den gesetzlichen Vorgaben (§4 ArbZG).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-breaks-toggle" className="text-base font-medium">
                        Auto-Pausen beim Monatsabschluss
                      </Label>
                      <Switch
                        id="auto-breaks-toggle"
                        data-testid="switch-auto-breaks"
                        checked={settings?.autoBreaksEnabled ?? true}
                        disabled={toggleMutation.isPending}
                        onCheckedChange={(checked) => toggleMutation.mutate(checked)}
                      />
                    </div>
                    <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                      <p className="font-medium mb-1">Gesetzliche Regelung (§4 ArbZG):</p>
                      <ul className="list-disc list-inside space-y-1">
                        <li>Unter 6 Stunden: Keine Pause erforderlich</li>
                        <li>6 bis 9 Stunden: Mindestens 30 Minuten Pause</li>
                        <li>Über 9 Stunden: Mindestens 45 Minuten Pause</li>
                      </ul>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <BackfillBudgetCard />
            </div>
          )}
    </Layout>
  );
}
