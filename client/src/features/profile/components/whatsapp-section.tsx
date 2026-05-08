import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { validateDachPhone } from "@shared/utils/phone";
import { Phone, MessageCircle, Loader2, Save } from "lucide-react";
import { iconSize } from "@/design-system";
import type { WhatsAppPrefs } from "../types";

export function WhatsAppSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [initialized, setInitialized] = useState(false);

  const { data: prefs, isLoading } = useQuery<WhatsAppPrefs>({
    queryKey: ["whatsapp-preferences"],
    queryFn: async () => {
      const result = await api.get<WhatsAppPrefs>("/whatsapp/preferences");
      return unwrapResult(result);
    },
  });

  useEffect(() => {
    if (prefs && !initialized) {
      setWhatsappNumber(prefs.whatsappNumber || "");
      setInitialized(true);
    }
  }, [prefs, initialized]);

  const updateMutation = useMutation({
    mutationFn: async (data: { enabled: boolean; whatsappNumber?: string | null }) => {
      const result = await api.put("/whatsapp/preferences", {
        enabled: data.enabled,
        whatsappNumber: data.whatsappNumber ?? null,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-preferences"] });
      toast({ title: "WhatsApp-Einstellungen gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      let normalizedNumber: string | null = null;
      if (whatsappNumber.trim()) {
        const phoneResult = validateDachPhone(whatsappNumber);
        if (!phoneResult.valid) {
          throw new Error(phoneResult.error);
        }
        normalizedNumber = phoneResult.normalized;
      }
      const result = await api.put("/whatsapp/preferences", {
        enabled: prefs?.enabled ?? false,
        whatsappNumber: normalizedNumber,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-preferences"] });
      toast({ title: "WhatsApp-Nummer gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <SectionCard title="WhatsApp-Benachrichtigungen" icon={<MessageCircle className={iconSize.sm} />}>
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="WhatsApp-Benachrichtigungen" icon={<MessageCircle className={iconSize.sm} />}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">WhatsApp-Benachrichtigungen aktivieren</p>
            <p className="text-xs text-muted-foreground">Erhalte wichtige Benachrichtigungen per WhatsApp</p>
          </div>
          <Switch
            checked={prefs?.enabled ?? false}
            onCheckedChange={(checked) => updateMutation.mutate({ enabled: checked, whatsappNumber: prefs?.whatsappNumber })}
            disabled={updateMutation.isPending}
            data-testid="switch-whatsapp-enabled"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp-number">Separate WhatsApp-Nummer (optional)</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="whatsapp-number"
                type="tel"
                value={whatsappNumber}
                onChange={(e) => setWhatsappNumber(e.target.value)}
                placeholder="z.B. 0171 1234567"
                className="pl-10 text-base"
                data-testid="input-whatsapp-number"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-whatsapp-number"
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leer lassen, um die hinterlegte Telefonnummer zu verwenden.
          </p>
        </div>

        <p className="text-xs text-muted-foreground border-t pt-3" data-testid="text-whatsapp-info">
          Du erhältst Benachrichtigungen über neue Termine, Aufgaben und Kunden-Zuweisungen per WhatsApp. Die Nachrichtentypen werden von der Administration konfiguriert.
        </p>
      </div>
    </SectionCard>
  );
}
