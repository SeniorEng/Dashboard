import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { PawPrint } from "lucide-react";
import { iconSize } from "@/design-system";
import type { ProfileData } from "../types";

export function PetAcceptanceSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: async (value: boolean) => {
      const result = await api.patch("/profile", { haustierAkzeptiert: value });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "profile");
      toast({ title: "Einstellung gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <SectionCard title="Haustiere" icon={<PawPrint className={iconSize.sm} />}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Haustiere akzeptiert</p>
          <p className="text-xs text-muted-foreground">Ich bin bereit, bei Kunden mit Haustieren zu arbeiten</p>
        </div>
        <Switch
          checked={profile.haustierAkzeptiert}
          onCheckedChange={(checked) => updateMutation.mutate(checked)}
          disabled={updateMutation.isPending}
          data-testid="switch-pet-acceptance"
        />
      </div>
    </SectionCard>
  );
}
