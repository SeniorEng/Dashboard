import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle } from "lucide-react";
import { iconSize } from "@/design-system";
import {
  AuthBrandingLogo,
  AuthLayout,
} from "@/components/auth/auth-layout";
import { api, unwrapResult } from "@/lib/api/client";

export default function SetupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [vorname, setVorname] = useState("");
  const [nachname, setNachname] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) {
        throw new Error("Passwörter stimmen nicht überein");
      }

      const result = await api.post("/auth/setup", {
        email,
        password,
        vorname,
        nachname,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      window.location.href = "/";
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setupMutation.mutate();
  };

  return (
    <AuthLayout>
      <CardHeader className="text-center pb-2">
        <AuthBrandingLogo testId="img-setup-logo" />
        <CardTitle className="text-xl font-bold text-gray-900">
          Ersteinrichtung
        </CardTitle>
        <CardDescription>
          Erstellen Sie das erste Administrator-Konto
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className={iconSize.sm} />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vorname">Vorname</Label>
              <Input
                id="vorname"
                type="text"
                placeholder="Max"
                value={vorname}
                onChange={(e) => setVorname(e.target.value)}
                required
                data-testid="input-setup-vorname"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nachname">Nachname</Label>
              <Input
                id="nachname"
                type="text"
                placeholder="Mustermann"
                value={nachname}
                onChange={(e) => setNachname(e.target.value)}
                required
                data-testid="input-setup-nachname"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">E-Mail-Adresse</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@beispiel.de"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="input-setup-email"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Passwort</Label>
            <Input
              id="password"
              type="password"
              placeholder="Mindestens 8 Zeichen"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              data-testid="input-setup-password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Passwort bestätigen</Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="Passwort wiederholen"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              data-testid="input-confirm-password"
            />
          </div>

          <Button
            type="submit"
            className="w-full bg-teal-600 hover:bg-teal-700"
            disabled={setupMutation.isPending}
            data-testid="button-setup"
          >
            {setupMutation.isPending ? (
              <>
                <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                Einrichten...
              </>
            ) : (
              "Administrator erstellen"
            )}
          </Button>
        </form>
      </CardContent>
    </AuthLayout>
  );
}
