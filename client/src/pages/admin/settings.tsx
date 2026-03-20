import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, FileText, Wrench, Landmark, Phone } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import type { SystemSettings, CompanySettings } from "@shared/schema";
import { emptyCompanyForm } from "./settings/types";
import { LogoUploadCard } from "./settings/logo-upload";
import { LeadAutoReplyCard } from "./settings/lead-auto-reply-card";
import { CompanyDetailsForm } from "./settings/company-details-form";
import { SmtpSettingsCard } from "./settings/smtp-settings";
import { EPostSettingsCard } from "./settings/epost-settings";

function BackfillBudgetCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<{ total: number; created: number; skipped: number; errors: number } | null>(null);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ total: number; created: number; skipped: number; errors: number }>("/admin/budget/backfill-transactions", {});
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
        qontoLogin: companyData.qontoLogin ?? "",
        qontoSecretKey: companyData.qontoSecretKey ?? "",
        qontoIban: companyData.qontoIban ?? "",
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

  const saveFirst = async () => {
    await companySaveMutation.mutateAsync(companyForm);
  };

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
                onSubmit={() => companySaveMutation.mutate(companyForm)}
                isSaving={companySaveMutation.isPending}
              />

              <SmtpSettingsCard
                companyForm={companyForm}
                updateField={updateField}
                onSaveFirst={saveFirst}
              />

              <EPostSettingsCard
                companyForm={companyForm}
                updateField={updateField}
                onSaveFirst={saveFirst}
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
                    <p className="text-xs text-muted-foreground">
                      Einstellungen werden beim Speichern der Firmendaten mit gespeichert. Zahlungsabgleich unter Zahlungen & Qonto.
                    </p>
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
                          onChange={(e) => updateField("twilioPhoneNumber", e.target.value)}
                          placeholder="+49..."
                          data-testid="input-twilio-phone-number"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="leadCallBridgePhone">Mitarbeiter-Rufnummer</Label>
                        <Input
                          id="leadCallBridgePhone"
                          value={companyForm.leadCallBridgePhone}
                          onChange={(e) => updateField("leadCallBridgePhone", e.target.value)}
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
                          try {
                            await companySaveMutation.mutateAsync(companyForm);
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
                    <p className="text-xs text-muted-foreground">
                      Einstellungen werden beim Speichern der Firmendaten mit gespeichert. Bei aktivierter Brücke wird der Mitarbeiter automatisch angerufen, sobald ein neuer Lead mit Telefonnummer eingeht.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <LeadAutoReplyCard
                companyForm={companyForm}
                companyData={companyData}
                updateField={updateField}
                companySaveMutation={companySaveMutation}
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
