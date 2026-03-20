import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Truck, CheckCircle2, XCircle, Eye, EyeOff, Smartphone, KeyRound, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanySettings } from "@shared/schema";
import type { CompanyFormData } from "./types";

interface EPostSettingsCardProps {
  companyForm: CompanyFormData;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
}

function pickEpostFields(form: CompanyFormData) {
  return {
    epostVendorId: form.epostVendorId,
    epostEkp: form.epostEkp,
    epostPassword: form.epostPassword,
    epostSecret: form.epostSecret,
    epostTestMode: form.epostTestMode,
  };
}

export function EPostSettingsCard({ companyForm, updateField }: EPostSettingsCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showEpostPass, setShowEpostPass] = useState(false);
  const [epostTestResult, setEpostTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [epostActivationStep, setEpostActivationStep] = useState<"idle" | "sms_sent" | "setting_password">("idle");
  const [epostSmsCode, setEpostSmsCode] = useState("");
  const [epostNewPassword, setEpostNewPassword] = useState("");
  const [showEpostNewPass, setShowEpostNewPass] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", pickEpostFields(companyForm));
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "E-POST-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Speichern", description: error.message, variant: "destructive" });
    },
  });

  const epostTestMutation = useMutation({
    mutationFn: async () => {
      await saveMutation.mutateAsync();
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

  return (
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
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
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
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
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

          <div className="flex justify-end pt-2 border-t">
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-epost"
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
