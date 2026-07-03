import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { formatEuroDE, parseEuroDE } from "@shared/utils/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, FileText, Landmark, Phone, Save } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import type { SystemSettings, CompanySettings } from "@shared/schema";
import { formatPhoneAsYouType, validateDachPhone } from "@shared/utils/phone";
import { isValidPhoneNumber } from "libphonenumber-js/min";
import { emptyCompanyForm } from "./settings/types";
import { LogoUploadCard } from "./settings/logo-upload";
import { LeadAutoReplyCard } from "./settings/lead-auto-reply-card";
import { CompanyDetailsForm } from "./settings/company-details-form";
import { SmtpSettingsCard } from "./settings/smtp-settings";
import { LetterxpressSettingsCard } from "./settings/letterxpress-settings";
import { BackfillBudgetCard, RepairOrphanedTransactionsCard } from "./settings/budget-maintenance-cards";

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;

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
        bankAccountHolder: companyData.bankAccountHolder ?? "",
        ikNummer: companyData.ikNummer ?? "",
        smtpHost: companyData.smtpHost ?? "",
        smtpPort: companyData.smtpPort ?? "",
        smtpUser: companyData.smtpUser ?? "",
        smtpPass: companyData.smtpPass ?? "",
        smtpFromEmail: companyData.smtpFromEmail ?? "",
        smtpFromName: companyData.smtpFromName ?? "",
        smtpSecure: companyData.smtpSecure ?? false,
        letterxpressUsername: companyData.letterxpressUsername ?? "",
        letterxpressApiKey: companyData.letterxpressApiKey ?? "",
        letterxpressTestMode: companyData.letterxpressTestMode ?? true,
        deliveryEmailSubject: companyData.deliveryEmailSubject ?? "",
        deliveryCoverLetterText: companyData.deliveryCoverLetterText ?? "",
        qontoLogin: companyData.qontoLogin ?? "",
        qontoSecretKey: companyData.qontoSecretKey ?? "",
        qontoIban: companyData.qontoIban ?? "",
        qontoAdditionalIbans: (companyData.qontoAdditionalIbans ?? []).join("\n"),
        twilioAccountSid: companyData.twilioAccountSid ?? "",
        twilioAuthToken: companyData.twilioAuthToken ?? "",
        twilioPhoneNumber: companyData.twilioPhoneNumber ?? "",
        leadCallBridgePhone: companyData.leadCallBridgePhone ?? "",
        leadCallBridgeEnabled: companyData.leadCallBridgeEnabled ?? false,
        leadAutoReplyEnabled: companyData.leadAutoReplyEnabled ?? false,
        leadAutoReplySubject: companyData.leadAutoReplySubject ?? "",
        leadAutoReplyBody: companyData.leadAutoReplyBody ?? "",
        leadAutoReplyAttachmentPath: companyData.leadAutoReplyAttachmentPath ?? "",
        leadAutoReplyAttachmentName: companyData.leadAutoReplyAttachmentName ?? "",
      });
    }
  }, [companyData]);

  const updateField = (field: keyof typeof companyForm, value: string | boolean) => {
    setCompanyForm((prev) => ({ ...prev, [field]: value }));
  };

  const companyOnlyFields = {
    companyName: companyForm.companyName,
    geschaeftsfuehrer: companyForm.geschaeftsfuehrer,
    strasse: companyForm.strasse,
    hausnummer: companyForm.hausnummer,
    plz: companyForm.plz,
    stadt: companyForm.stadt,
    telefon: companyForm.telefon,
    email: companyForm.email,
    website: companyForm.website,
    steuernummer: companyForm.steuernummer,
    ustId: companyForm.ustId,
    iban: companyForm.iban,
    bic: companyForm.bic,
    bankName: companyForm.bankName,
    bankAccountHolder: companyForm.bankAccountHolder?.trim() ? companyForm.bankAccountHolder.trim() : null,
    ikNummer: companyForm.ikNummer,
  };

  const validateCompanyPhone = () => {
    if (companyForm.telefon && companyForm.telefon.trim()) {
      const result = validateDachPhone(companyForm.telefon);
      if (!result.valid) {
        toast({ title: "Ungültige Telefonnummer", description: result.error, variant: "destructive" });
        return false;
      }
    }
    return true;
  };

  const validateTwilioPhones = () => {
    if (companyForm.twilioPhoneNumber && companyForm.twilioPhoneNumber.trim()) {
      const val = companyForm.twilioPhoneNumber.trim();
      if (!isValidPhoneNumber(val, "DE") && !isValidPhoneNumber(val)) {
        toast({ title: "Ungültige Twilio-Telefonnummer", variant: "destructive" });
        return false;
      }
    }
    if (companyForm.leadCallBridgePhone && companyForm.leadCallBridgePhone.trim()) {
      const val = companyForm.leadCallBridgePhone.trim();
      if (!isValidPhoneNumber(val, "DE") && !isValidPhoneNumber(val)) {
        toast({ title: "Ungültige Mitarbeiter-Rufnummer", variant: "destructive" });
        return false;
      }
    }
    return true;
  };

  const companySaveMutation = useMutation({
    mutationFn: async (data: typeof companyOnlyFields) => {
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

  const qontoSaveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", {
        qontoLogin: companyForm.qontoLogin,
        qontoSecretKey: companyForm.qontoSecretKey,
        qontoIban: companyForm.qontoIban,
        qontoAdditionalIbans: companyForm.qontoAdditionalIbans
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Qonto-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const twilioSaveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", {
        twilioAccountSid: companyForm.twilioAccountSid,
        twilioAuthToken: companyForm.twilioAuthToken,
        twilioPhoneNumber: companyForm.twilioPhoneNumber,
        leadCallBridgePhone: companyForm.leadCallBridgePhone,
        leadCallBridgeEnabled: companyForm.leadCallBridgeEnabled,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Twilio-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const coverLetterSaveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", {
        deliveryEmailSubject: companyForm.deliveryEmailSubject,
        deliveryCoverLetterText: companyForm.deliveryCoverLetterText,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Anschreiben-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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
      setMinijobLimit(formatEuroDE(companyData.minijobEarningsLimitCents, { withCurrency: false }));
    }
  }, [companyData?.minijobEarningsLimitCents]);

  const minijobLimitMutation = useMutation({
    mutationFn: async (limitEuro: string) => {
      const cents = parseEuroDE(limitEuro);
      if (cents === null) {
        throw new Error("Ungültiger Betrag");
      }
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
              <LogoUploadCard companyData={companyData} />

              <CompanyDetailsForm
                companyForm={companyForm}
                updateField={updateField}
                onSubmit={() => { if (validateCompanyPhone()) companySaveMutation.mutate(companyOnlyFields); }}
                isSaving={companySaveMutation.isPending}
              />

              <SmtpSettingsCard
                companyForm={companyForm}
                updateField={updateField}
              />

              <LetterxpressSettingsCard
                companyForm={companyForm}
                updateField={updateField}
              />

              {isSuperAdmin && (
              <Card data-testid="card-qonto-settings">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Landmark className="h-5 w-5 text-sky-600" />
                    Qonto-Bankverbindung
                  </CardTitle>
                  <CardDescription>
                    Zugangsdaten für den automatischen Zahlungsabgleich über Qonto.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="qontoLogin">Qonto Login</Label>
                        <Input
                          id="qontoLogin"
                          value={companyForm.qontoLogin}
                          onChange={(e) => updateField("qontoLogin", e.target.value)}
                          placeholder="organisation-slug"
                          data-testid="input-qonto-login"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="qontoSecretKey">Secret Key</Label>
                        <Input
                          id="qontoSecretKey"
                          type="password"
                          value={companyForm.qontoSecretKey}
                          onChange={(e) => updateField("qontoSecretKey", e.target.value)}
                          placeholder="Qonto Secret Key"
                          data-testid="input-qonto-secret-key"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="qontoIban">IBAN (Geschäftskonto)</Label>
                      <Input
                        id="qontoIban"
                        value={companyForm.qontoIban}
                        onChange={(e) => updateField("qontoIban", e.target.value)}
                        placeholder="DE89 3704 0044 0532 0130 00"
                        data-testid="input-qonto-iban"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="qontoAdditionalIbans">Weitere IBANs (gleicher Qonto-Login)</Label>
                      <Textarea
                        id="qontoAdditionalIbans"
                        value={companyForm.qontoAdditionalIbans}
                        onChange={(e) => updateField("qontoAdditionalIbans", e.target.value)}
                        placeholder="Eine IBAN pro Zeile"
                        rows={3}
                        data-testid="input-qonto-additional-ibans"
                      />
                      <p className="text-xs text-muted-foreground">
                        Optional: zusätzliche Konten desselben Qonto-Logins, die im Zahlungsabgleich mitsynchronisiert werden. Eine IBAN pro Zeile.
                      </p>
                    </div>
                    <div className="flex justify-end pt-2 border-t">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => qontoSaveMutation.mutate()}
                        disabled={qontoSaveMutation.isPending}
                        data-testid="button-save-qonto"
                      >
                        {qontoSaveMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Speichern
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
              )}

              <Card data-testid="card-lead-call-bridge">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Phone className="h-5 w-5 text-green-600" />
                    Lead-Anruf-Brücke (Twilio)
                  </CardTitle>
                  <CardDescription>
                    Automatischer Anruf bei neuem Lead: Das System ruft den Mitarbeiter an und verbindet ihn per Tastendruck mit dem Interessenten.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="lead-bridge-toggle" className="text-base font-medium">
                        Anruf-Brücke aktiviert
                      </Label>
                      <Switch
                        id="lead-bridge-toggle"
                        data-testid="switch-lead-call-bridge"
                        checked={companyForm.leadCallBridgeEnabled}
                        onCheckedChange={(checked) => updateField("leadCallBridgeEnabled", checked)}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="twilioAccountSid">Twilio Account SID</Label>
                        <Input
                          id="twilioAccountSid"
                          value={companyForm.twilioAccountSid}
                          onChange={(e) => updateField("twilioAccountSid", e.target.value)}
                          placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                          data-testid="input-twilio-account-sid"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="twilioAuthToken">Auth Token</Label>
                        <Input
                          id="twilioAuthToken"
                          type="password"
                          value={companyForm.twilioAuthToken}
                          onChange={(e) => updateField("twilioAuthToken", e.target.value)}
                          placeholder="Twilio Auth Token"
                          data-testid="input-twilio-auth-token"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="twilioPhoneNumber">Twilio-Telefonnummer (Absender)</Label>
                        <Input
                          id="twilioPhoneNumber"
                          value={companyForm.twilioPhoneNumber}
                          onChange={(e) => updateField("twilioPhoneNumber", formatPhoneAsYouType(e.target.value))}
                          placeholder="+49..."
                          data-testid="input-twilio-phone-number"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="leadCallBridgePhone">Mitarbeiter-Rufnummer</Label>
                        <Input
                          id="leadCallBridgePhone"
                          value={companyForm.leadCallBridgePhone}
                          onChange={(e) => updateField("leadCallBridgePhone", formatPhoneAsYouType(e.target.value))}
                          placeholder="+49..."
                          data-testid="input-lead-call-bridge-phone"
                        />
                      </div>
                    </div>
                    {isSuperAdmin && (
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!companyForm.twilioAccountSid || !companyForm.twilioAuthToken || !companyForm.twilioPhoneNumber || !companyForm.leadCallBridgePhone}
                        data-testid="button-test-call"
                        onClick={async () => {
                          if (!validateTwilioPhones()) return;
                          try {
                            await twilioSaveMutation.mutateAsync();
                            const res = await api.post<{ success: boolean; message: string }>("/admin/twilio/test-call", {});
                            const result = unwrapResult(res);
                            toast({
                              title: result.success ? "Testanruf gestartet" : "Testanruf fehlgeschlagen",
                              description: result.message,
                              variant: result.success ? "default" : "destructive",
                            });
                          } catch (err: unknown) {
                            toast({ title: "Fehler", description: err instanceof Error ? err.message : "Unbekannter Fehler", variant: "destructive" });
                          }
                        }}
                      >
                        <Phone className="h-4 w-4 mr-2" />
                        Testanruf
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Speichert zuerst die Einstellungen und ruft dann die Mitarbeiter-Nummer an.
                      </span>
                    </div>
                    )}
                    <div className="flex justify-end pt-2 border-t">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => { if (validateTwilioPhones()) twilioSaveMutation.mutate(); }}
                        disabled={twilioSaveMutation.isPending}
                        data-testid="button-save-twilio"
                      >
                        {twilioSaveMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Speichern
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <LeadAutoReplyCard
                companyForm={companyForm}
                companyData={companyData}
                updateField={updateField}
              />

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
                    <div className="flex justify-end pt-2 border-t">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => coverLetterSaveMutation.mutate()}
                        disabled={coverLetterSaveMutation.isPending}
                        data-testid="button-save-cover-letter"
                      >
                        {coverLetterSaveMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Speichern
                      </Button>
                    </div>
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
              <RepairOrphanedTransactionsCard />
            </div>
          )}
    </Layout>
  );
}
