import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Truck, CheckCircle2, XCircle, Eye, EyeOff, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanySettings } from "@shared/schema";
import type { CompanyFormData } from "./types";

interface LetterxpressSettingsCardProps {
  companyForm: CompanyFormData;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
}

function pickLetterxpressFields(form: CompanyFormData) {
  return {
    letterxpressUsername: form.letterxpressUsername,
    letterxpressApiKey: form.letterxpressApiKey,
    letterxpressTestMode: form.letterxpressTestMode,
  };
}

export function LetterxpressSettingsCard({ companyForm, updateField }: LetterxpressSettingsCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; balance?: number } | null>(null);

  const healthQuery = useQuery({
    queryKey: ["letterxpress-health"],
    queryFn: async () => {
      const result = await api.get<{ success: boolean; error?: string }>(
        "/admin/document-delivery/letterxpress-health"
      );
      return unwrapResult(result);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", pickLetterxpressFields(companyForm));
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "LetterXpress-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Speichern", description: error.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      await saveMutation.mutateAsync();
      const result = await api.post<{ success: boolean; error?: string; balance?: number }>(
        "/admin/document-delivery/test-letterxpress",
        {}
      );
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      setTestResult(data);
      toast({
        title: data.success ? "LetterXpress-Verbindung erfolgreich" : "LetterXpress-Verbindung fehlgeschlagen",
        description: data.success && typeof data.balance === "number" ? `Guthaben: ${data.balance.toFixed(2)} €` : data.error,
        variant: data.success ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      setTestResult({ success: false, error: error.message });
      toast({ title: "LetterXpress-Test fehlgeschlagen", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-letterxpress-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Truck className="h-5 w-5 text-amber-600" />
          LetterXpress Briefversand
        </CardTitle>
        <CardDescription>
          API-Zugangsdaten für den automatischen Briefversand über LetterXpress.
        </CardDescription>
        <div className="mt-2 text-xs flex items-center gap-1.5" data-testid="status-letterxpress-health">
          {healthQuery.isLoading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-gray-500" />
              <span className="text-gray-500">API-Status wird geprüft …</span>
            </>
          ) : healthQuery.data?.success ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-green-600" />
              <span className="text-green-700">LetterXpress-API erreichbar</span>
            </>
          ) : (
            <>
              <XCircle className="h-3 w-3 text-red-600" />
              <span className="text-red-700">
                LetterXpress-API nicht erreichbar{healthQuery.data?.error ? ` — ${healthQuery.data.error}` : ""}
              </span>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="letterxpressUsername">Benutzername</Label>
              <Input
                id="letterxpressUsername"
                value={companyForm.letterxpressUsername}
                onChange={(e) => updateField("letterxpressUsername", e.target.value)}
                placeholder="LetterXpress-Benutzername"
                data-testid="input-letterxpress-username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="letterxpressApiKey">API-Key</Label>
              <div className="relative">
                <Input
                  id="letterxpressApiKey"
                  type={showApiKey ? "text" : "password"}
                  value={companyForm.letterxpressApiKey}
                  onChange={(e) => updateField("letterxpressApiKey", e.target.value)}
                  placeholder="••••••••"
                  data-testid="input-letterxpress-api-key"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="letterxpressTestMode">Testmodus</Label>
              <p className="text-xs text-muted-foreground">
                Im Testmodus werden Briefe nicht gedruckt oder abgerechnet. Für Produktivbetrieb deaktivieren.
              </p>
            </div>
            <Switch
              id="letterxpressTestMode"
              checked={companyForm.letterxpressTestMode}
              onCheckedChange={(checked) => updateField("letterxpressTestMode", checked)}
              data-testid="switch-letterxpress-test-mode"
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testMutation.isPending || !companyForm.letterxpressUsername || !companyForm.letterxpressApiKey}
              onClick={() => testMutation.mutate()}
              data-testid="button-test-letterxpress"
            >
              {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
              Verbindung testen
            </Button>
            {testResult && (
              <div className={`flex items-center gap-1.5 text-sm ${testResult.success ? "text-green-600" : "text-red-600"}`}>
                {testResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {testResult.success
                  ? typeof testResult.balance === "number"
                    ? `Verbindung OK · Guthaben: ${testResult.balance.toFixed(2)} €`
                    : "Verbindung OK"
                  : testResult.error}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-2 border-t">
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-letterxpress"
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
