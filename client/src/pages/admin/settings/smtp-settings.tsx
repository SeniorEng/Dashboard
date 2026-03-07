import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, CheckCircle2, XCircle, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanyFormData } from "./types";

interface SmtpSettingsCardProps {
  companyForm: CompanyFormData;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
  onSaveFirst: () => Promise<void>;
}

export function SmtpSettingsCard({ companyForm, updateField, onSaveFirst }: SmtpSettingsCardProps) {
  const { toast } = useToast();
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  const smtpTestMutation = useMutation({
    mutationFn: async () => {
      await onSaveFirst();
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
  );
}
