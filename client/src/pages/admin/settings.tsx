import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import type { SystemSettings } from "@shared/schema";

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<SystemSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings", { credentials: "include" });
      if (!res.ok) throw new Error("Einstellungen konnten nicht geladen werden");
      return res.json();
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

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Einstellungen</h1>
              <p className="text-gray-600">Systemweite Konfiguration</p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
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
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
