import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Heart, CheckCircle, ArrowLeft } from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [success, setSuccess] = useState(false);
  const { toast } = useToast();

  const requestResetMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post<{ success: boolean; message: string }>(
        "/auth/password-reset/request",
        { email }
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      setSuccess(true);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    requestResetMutation.mutate();
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <CheckCircle className={`${iconSize.lg} text-green-600`} />
            </div>
            <CardTitle className="text-2xl font-bold text-gray-900">E-Mail gesendet</CardTitle>
            <CardDescription>
              Falls ein Konto mit dieser E-Mail-Adresse existiert, haben wir Ihnen eine Anleitung zum Zurücksetzen Ihres Passworts gesendet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600 text-center">
              Bitte überprüfen Sie Ihr E-Mail-Postfach und folgen Sie den Anweisungen in der E-Mail.
            </p>
            <Link href="/login">
              <Button
                variant="outline"
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
          <CardTitle className="text-2xl font-bold text-gray-900">Passwort vergessen</CardTitle>
          <CardDescription>
            Geben Sie Ihre E-Mail-Adresse ein, um Ihr Passwort zurückzusetzen
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {requestResetMutation.isError && (
              <Alert variant="destructive">
                <AlertCircle className={iconSize.sm} />
                <AlertDescription>
                  {(requestResetMutation.error as Error)?.message || "Ein Fehler ist aufgetreten"}
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@beispiel.de"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-reset-email"
              />
            </div>

            <Button
              type="submit"
              className="w-full bg-teal-600 hover:bg-teal-700"
              disabled={requestResetMutation.isPending}
              data-testid="button-request-reset"
            >
              {requestResetMutation.isPending ? (
                <>
                  <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                  Senden...
                </>
              ) : (
                "Passwort zurücksetzen"
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
