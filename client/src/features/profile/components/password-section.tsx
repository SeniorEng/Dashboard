import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { Lock, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";

export function PasswordSection() {
  const { toast } = useToast();
  const [isChanging, setIsChanging] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const changeMutation = useMutation({
    mutationFn: async () => {
      if (!currentPassword) throw new Error("Aktuelles Passwort ist erforderlich");
      if (newPassword.length < 8) throw new Error("Neues Passwort muss mindestens 8 Zeichen haben");
      if (newPassword !== confirmPassword) throw new Error("Passwörter stimmen nicht überein");
      const result = await api.post("/auth/change-password", { currentPassword, newPassword });
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Passwort geändert", description: "Sie werden abgemeldet und müssen sich neu anmelden." });
      setTimeout(() => {
        window.location.href = "/login";
      }, 1500);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setIsChanging(false);
  };

  return (
    <SectionCard title="Passwort" icon={<Lock className={iconSize.sm} />}>
      {isChanging ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Aktuelles Passwort</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Aktuelles Passwort eingeben"
              className="text-base"
              data-testid="input-current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">Neues Passwort</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Mindestens 8 Zeichen"
              className="text-base"
              data-testid="input-new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Neues Passwort bestätigen</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Neues Passwort wiederholen"
              className="text-base"
              data-testid="input-confirm-password"
            />
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <p className="text-sm text-destructive">Passwörter stimmen nicht überein</p>
          )}
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => changeMutation.mutate()}
              disabled={changeMutation.isPending || !currentPassword || !newPassword || !confirmPassword || newPassword !== confirmPassword}
              className="flex-1"
              data-testid="button-save-password"
            >
              {changeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
              Passwort ändern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={changeMutation.isPending} data-testid="button-cancel-password">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setIsChanging(true)} className="w-full" data-testid="button-change-password">
          <Lock className="h-4 w-4 mr-2" />
          Passwort ändern
        </Button>
      )}
    </SectionCard>
  );
}
