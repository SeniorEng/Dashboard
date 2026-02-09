import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { iconSize } from "@/design-system";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { UserData } from "./user-types";

export function ResetPasswordForm({
  user,
  onSubmit,
  isLoading,
}: {
  user: UserData;
  onSubmit: (newPassword: string) => void;
  isLoading: boolean;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwörter stimmen nicht überein");
      return;
    }
    setError("");
    onSubmit(newPassword);
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Passwort zurücksetzen</DialogTitle>
        <DialogDescription>
          Setzen Sie das Passwort für {user.displayName} zurück.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="newPassword">Neues Passwort</Label>
          <Input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            data-testid="input-new-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Passwort bestätigen</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            data-testid="input-confirm-new-password"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="button-submit-reset-password">
          {isLoading ? (
            <>
              <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
              Zurücksetzen...
            </>
          ) : (
            "Zurücksetzen"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
