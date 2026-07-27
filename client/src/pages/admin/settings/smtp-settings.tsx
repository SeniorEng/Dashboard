import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, CheckCircle2, XCircle, Eye, EyeOff, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanySettings } from "@shared/schema";
import type { CompanyFormData } from "./types";

interface SmtpSettingsCardProps {
  companyForm: CompanyFormData;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
}

function pickSmtpFields(form: CompanyFormData) {
  return {
    smtpHost: form.smtpHost,
    smtpPort: form.smtpPort,
    smtpUser: form.smtpUser,
    smtpPass: form.smtpPass,
    smtpFromEmail: form.smtpFromEmail,
    smtpFromName: form.smtpFromName,
    smtpSecure: form.smtpSecure,
    // Task #1856 — email provider selection + Microsoft Graph credentials must
    // travel with the PATCH payload, otherwise the UI never sends them.
    emailProvider: form.emailProvider,
    graphTenantId: form.graphTenantId,
    graphClientId: form.graphClientId,
    graphSenderUpn: form.graphSenderUpn,
    graphClientSecret: form.graphClientSecret,
  };
}

export function SmtpSettingsCard({ companyForm, updateField }: SmtpSettingsCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [showGraphSecret, setShowGraphSecret] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", pickSmtpFields(companyForm));
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "SMTP-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Speichern", description: error.message, variant: "destructive" });
    },
  });

  const smtpTestMutation = useMutation({
    mutationFn: async () => {
      await saveMutation.mutateAsync();
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

  return (
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
          <div className="space-y-2">
            <Label htmlFor="emailProvider">E-Mail-Versand-Methode</Label>
            <select
              id="emailProvider"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={companyForm.emailProvider}
              onChange={(e) => updateField("emailProvider", e.target.value)}
              data-testid="select-email-provider"
            >
              <option value="smtp">SMTP</option>
              <option value="graph">Microsoft Graph (OAuth2)</option>
            </select>
            <p className="text-xs text-gray-500">
              Microsoft schaltet Basic-Auth-SMTP Ende 2026 ab. „Microsoft Graph (OAuth2)" nutzt eine App-Identität ohne Postfach-Passwort.
            </p>
          </div>

          {companyForm.emailProvider === "graph" && (
            <div className="flex flex-col gap-3 rounded-lg border border-gray-200 p-3">
              <p className="text-sm font-medium text-gray-700">Microsoft Graph (App-only OAuth2)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="graphTenantId">Tenant-ID</Label>
                  <Input
                    id="graphTenantId"
                    value={companyForm.graphTenantId}
                    onChange={(e) => updateField("graphTenantId", e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    data-testid="input-graph-tenant-id"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="graphClientId">Client-ID (App-ID)</Label>
                  <Input
                    id="graphClientId"
                    value={companyForm.graphClientId}
                    onChange={(e) => updateField("graphClientId", e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    data-testid="input-graph-client-id"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="graphSenderUpn">Absender (UPN)</Label>
                  <Input
                    id="graphSenderUpn"
                    value={companyForm.graphSenderUpn}
                    onChange={(e) => updateField("graphSenderUpn", e.target.value)}
                    placeholder="info@firma.de"
                    data-testid="input-graph-sender-upn"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="graphClientSecret">Client-Secret</Label>
                  <div className="relative">
                    <Input
                      id="graphClientSecret"
                      type={showGraphSecret ? "text" : "password"}
                      value={companyForm.graphClientSecret}
                      onChange={(e) => updateField("graphClientSecret", e.target.value)}
                      placeholder="••••••••"
                      data-testid="input-graph-client-secret"
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                      onClick={() => setShowGraphSecret(!showGraphSecret)}
                    >
                      {showGraphSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
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
              disabled={
                smtpTestMutation.isPending ||
                (companyForm.emailProvider === "graph" ? !companyForm.graphTenantId : !companyForm.smtpHost)
              }
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
          <div className="flex justify-end pt-2 border-t">
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-smtp"
            >
              {saveMutation.isPending ? (
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
  );
}
