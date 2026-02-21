import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { iconSize } from "@/design-system";
import { useAuth } from "@/hooks/use-auth";
import logoImage from "@/assets/logo-seniorenengel.png";
import { api, unwrapResult } from "@/lib/api/client";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const { data: setupData, isLoading: setupLoading } = useQuery({
    queryKey: ["auth", "setup-required"],
    queryFn: async () => {
      const res = await fetch("/api/auth/setup-required");
      return res.json();
    },
  });

  const loginMutation = useMutation({
    mutationFn: async () => {
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

  if (authLoading || setupLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (setupData?.setupRequired) {
    return <SetupPage />;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    loginMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-2">
          <img 
            src={logoImage} 
            alt="SeniorenEngel" 
            className="h-16 mx-auto mb-2"
          />
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
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@beispiel.de"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Passwort</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-10"
                  data-testid="input-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className={iconSize.sm} /> : <Eye className={iconSize.sm} />}
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
              <a
                href="/forgot-password"
                className="text-sm text-teal-600 hover:underline"
                data-testid="link-forgot-password"
              >
                Passwort vergessen?
              </a>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function SetupPage() {
  const [, navigate] = useLocation();
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

      const result = await api.post("/auth/setup", { email, password, vorname, nachname });
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-2">
          <img 
            src={logoImage} 
            alt="SeniorenEngel" 
            className="h-16 mx-auto mb-2"
          />
          <CardTitle className="text-xl font-bold text-gray-900">Ersteinrichtung</CardTitle>
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
      </Card>
    </div>
  );
}
