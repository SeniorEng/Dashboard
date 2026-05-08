import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatPhoneForDisplay, validateDachPhone } from "@shared/utils/phone";
import { User as UserIcon, Phone, Heart, AlertTriangle, Loader2, Save } from "lucide-react";
import { iconSize } from "@/design-system";
import { InfoRow } from "./info-row";
import type { ProfileData } from "../types";

export function EmergencyContactSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    notfallkontaktName: profile.notfallkontaktName || "",
    notfallkontaktTelefon: profile.notfallkontaktTelefon || "",
    notfallkontaktBeziehung: profile.notfallkontaktBeziehung || "",
  });

  const updateMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const updates: Record<string, string> = {};
      if (data.notfallkontaktTelefon && data.notfallkontaktTelefon.trim()) {
        const phoneResult = validateDachPhone(data.notfallkontaktTelefon);
        if (!phoneResult.valid) {
          throw new Error(!phoneResult.valid ? phoneResult.error : "Ungültige Telefonnummer für Notfallkontakt");
        }
        updates.notfallkontaktTelefon = phoneResult.normalized;
      } else {
        updates.notfallkontaktTelefon = "";
      }
      updates.notfallkontaktName = data.notfallkontaktName;
      updates.notfallkontaktBeziehung = data.notfallkontaktBeziehung;

      const result = await api.patch("/profile", updates);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      setIsEditing(false);
      toast({ title: "Notfallkontakt aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setForm({
      notfallkontaktName: profile.notfallkontaktName || "",
      notfallkontaktTelefon: profile.notfallkontaktTelefon || "",
      notfallkontaktBeziehung: profile.notfallkontaktBeziehung || "",
    });
    setIsEditing(false);
  };

  const hasContact = profile.notfallkontaktName || profile.notfallkontaktTelefon;

  return (
    <SectionCard
      title="Notfallkontakt"
      icon={<AlertTriangle className={iconSize.sm} />}
      actions={
        !isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-emergency">
            {hasContact ? "Bearbeiten" : "Hinzufügen"}
          </Button>
        ) : undefined
      }
    >
      {isEditing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="emergency-name">Name</Label>
            <Input
              id="emergency-name"
              value={form.notfallkontaktName}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktName: e.target.value }))}
              placeholder="Name des Notfallkontakts"
              className="text-base"
              data-testid="input-emergency-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="emergency-phone">Telefon</Label>
            <Input
              id="emergency-phone"
              type="tel"
              value={form.notfallkontaktTelefon}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktTelefon: e.target.value }))}
              placeholder="z.B. 0171 1234567"
              className="text-base"
              data-testid="input-emergency-phone"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="emergency-relation">Beziehung</Label>
            <Input
              id="emergency-relation"
              value={form.notfallkontaktBeziehung}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktBeziehung: e.target.value }))}
              placeholder="z.B. Ehepartner, Eltern, Geschwister"
              className="text-base"
              data-testid="input-emergency-relation"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => updateMutation.mutate(form)}
              disabled={updateMutation.isPending}
              className="flex-1"
              data-testid="button-save-emergency"
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Speichern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={updateMutation.isPending} data-testid="button-cancel-emergency">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : hasContact ? (
        <div className="space-y-3">
          <InfoRow icon={<UserIcon className="h-4 w-4" />} label="Name" value={profile.notfallkontaktName || "—"} testId="text-emergency-name" />
          <InfoRow
            icon={<Phone className="h-4 w-4" />}
            label="Telefon"
            value={profile.notfallkontaktTelefon ? <a href={`tel:${profile.notfallkontaktTelefon}`} className="text-primary hover:underline">{formatPhoneForDisplay(profile.notfallkontaktTelefon)}</a> : "—"}
            testId="text-emergency-phone"
          />
          <InfoRow icon={<Heart className="h-4 w-4" />} label="Beziehung" value={profile.notfallkontaktBeziehung || "—"} testId="text-emergency-relation" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-no-emergency">
          Kein Notfallkontakt hinterlegt. Bitte fügen Sie einen Notfallkontakt hinzu.
        </p>
      )}
    </SectionCard>
  );
}
