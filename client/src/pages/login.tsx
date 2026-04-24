import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { iconSize } from "@/design-system";
import { useAuth } from "@/hooks/use-auth";
import {
  AuthBrandingLogo,
  AuthLayout,
  AuthLoadingScreen,
} from "@/components/auth/auth-layout";
import { api, unwrapResult } from "@/lib/api/client";
import SetupPage from "@/pages/setup";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const { data: setupData, isLoading: setupLoading } = useQuery({
    queryKey: ["auth", "setup-required"],
    queryFn: async () => {
      const result = await api.get<{ setupRequired: boolean }>(
        "/auth/setup-required",
      );
      return unwrapResult(result);
    },
  });

  const loginMutation = useMutation({
    mutationFn: async ({
      email,
      password,
    }: {
      email: string;
      password: string;
    }) => {
      await login(email, password);
    },
    onSuccess: () => {
      navigate("/");
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  useEffect(() => {
    if (isAuthenticated && !authLoading) {
      navigate("/");
    }
  }, [isAuthenticated, authLoading, navigate]);

  if (authLoading || setupLoading || isAuthenticated) {
    return <AuthLoadingScreen />;
  }

  if (setupData?.setupRequired) {
    return <SetupPage />;
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    if (!email || !password) {
      setError("Bitte E-Mail und Passwort eingeben.");
      return;
    }
    loginMutation.mutate({ email, password });
  };

  return (
    <AuthLayout>
      <CardHeader className="text-center pb-2">
        <AuthBrandingLogo testId="img-login-logo" />
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="space-y-4"
          autoComplete="on"
        >
          {error && (
            <Alert variant="destructive">
              <AlertCircle className={iconSize.sm} />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">E-Mail-Adresse</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="name@beispiel.de"
              required
              data-testid="input-email"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Passwort</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                required
                className="pr-10"
                data-testid="input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                aria-label={
                  showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                }
                data-testid="button-toggle-password"
              >
                {showPassword ? (
                  <EyeOff className={iconSize.sm} />
                ) : (
                  <Eye className={iconSize.sm} />
                )}
              </button>
            </div>
          </div>

          <Button
            type="submit"
            className="w-full bg-teal-600 hover:bg-teal-700"
            disabled={loginMutation.isPending}
            data-testid="button-login"
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />
                Anmelden...
              </>
            ) : (
              "Anmelden"
            )}
          </Button>

          <div className="text-center">
            <Link
              href="/forgot-password"
              className="text-sm text-teal-600 hover:underline"
              data-testid="link-forgot-password"
            >
              Passwort vergessen?
            </Link>
          </div>
        </form>
      </CardContent>
    </AuthLayout>
  );
}
