import { useState, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Heart, CheckCircle, ArrowLeft } from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const tokenFromUrl = params.get("token");
    if (tokenFromUrl) {
      setToken(tokenFromUrl);
    }
  }, [search]);

  const resetMutation = useMutation({
    mutationFn: async () => {
      if (newPassword !== confirmPassword) {
        throw new Error("Passwörter stimmen nicht überein");
      }
      if (newPassword.length < 8) {
        throw new Error("Das Passwort muss mindestens 8 Zeichen lang sein");
      }
      const result = await api.post<{ success: boolean }>(
        "/api/auth/password-reset/confirm",
        { token, newPassword }
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      setSuccess(true);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    resetMutation.mutate();
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <CheckCircle className={`${iconSize.lg} text-green-600`} />
            </div>
            <CardTitle className="text-2xl font-bold text-gray-900">Passwort geändert</CardTitle>
            <CardDescription>
              Ihr Passwort wurde erfolgreich zurückgesetzt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                className="w-full bg-teal-600 hover:bg-teal-700"
                data-testid="button-go-to-login"
              >
                Zur Anmeldung
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <AlertCircle className={`${iconSize.lg} text-red-600`} />
            </div>
            <CardTitle className="text-2xl font-bold text-gray-900">Ungültiger Link</CardTitle>
            <CardDescription>
              Dieser Link zum Zurücksetzen des Passworts ist ungültig oder abgelaufen.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Link href="/forgot-password">
              <Button
                variant="outline"
                className="w-full"
                data-testid="button-request-new-link"
              >
                Neuen Link anfordern
              </Button>
            </Link>
            <Link href="/login">
              <Button
                variant="ghost"
                className="w-full"
                data-testid="button-back-to-login"
              >
                <ArrowLeft className={`mr-2 ${iconSize.sm}`} />
                Zurück zur Anmeldung
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-teal-100">
            <Heart className={`${iconSize.lg} text-teal-600`} />
          </div>
          <CardTitle className="text-2xl font-bold text-gray-900">Neues Passwort</CardTitle>
          <CardDescription>
            Geben Sie Ihr neues Passwort ein
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

            <div className="space-y-2">
              <Label htmlFor="newPassword">Neues Passwort</Label>
              <Input
                id="newPassword"
                type="password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                data-testid="input-new-password"
              />
              <p className="text-xs text-gray-500">Mindestens 8 Zeichen</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Passwort bestätigen</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                data-testid="input-confirm-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full bg-teal-600 hover:bg-teal-700"
              disabled={resetMutation.isPending}
              data-testid="button-reset-password"
            >
              {resetMutation.isPending ? (
                <>
                  <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                  Speichern...
                </>
              ) : (
                "Passwort speichern"
              )}
            </Button>

            <div className="text-center">
              <Link
                href="/login"
                className="text-sm text-teal-600 hover:underline"
                data-testid="link-back-to-login"
              >
                Zurück zur Anmeldung
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
