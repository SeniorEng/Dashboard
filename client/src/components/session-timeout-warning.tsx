import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api/client";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

const WARNING_BEFORE_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

export function SessionTimeoutWarning() {
  const { isAuthenticated, logout } = useAuth();
  const [, navigate] = useLocation();
  const [showWarning, setShowWarning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleExpired = useCallback(async () => {
    setShowWarning(false);
    if (countdownRef.current) clearInterval(countdownRef.current);
    try {
      await logout();
    } catch {}
    navigate("/login");
  }, [logout, navigate]);

  const checkSession = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await fetch("/api/auth/session-info", { credentials: "include" });
      if (!res.ok) {
        handleExpired();
        return;
      }

      const data = await res.json();
      const now = Date.now();
      const idleExpires = data.idleExpiresAt;
      const absoluteExpires = data.absoluteExpiresAt;
      const effectiveExpiry = Math.min(idleExpires, absoluteExpires);
      const timeLeft = effectiveExpiry - now;

      if (timeLeft <= 0) {
        handleExpired();
      } else if (timeLeft <= WARNING_BEFORE_MS) {
        setRemainingSeconds(Math.ceil(timeLeft / 1000));
        setShowWarning(true);
      } else {
        setShowWarning(false);
      }
    } catch {
      // Network error - don't log out immediately, could be temporary
    }
  }, [isAuthenticated, handleExpired]);

  useEffect(() => {
    if (!isAuthenticated) {
      setShowWarning(false);
      return;
    }

    checkSession();
    checkRef.current = setInterval(checkSession, CHECK_INTERVAL_MS);

    return () => {
      if (checkRef.current) clearInterval(checkRef.current);
    };
  }, [isAuthenticated, checkSession]);

  useEffect(() => {
    if (showWarning) {
      countdownRef.current = setInterval(() => {
        setRemainingSeconds((prev) => {
          if (prev <= 1) {
            handleExpired();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    }

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [showWarning, handleExpired]);

  const handleKeepAlive = async () => {
    try {
      const res = await api.post("/auth/keepalive", {});
      if (res.success) {
        setShowWarning(false);
      } else {
        handleExpired();
      }
    } catch {
      handleExpired();
    }
  };

  const handleLogoutNow = async () => {
    setShowWarning(false);
    try {
      await logout();
    } catch {}
    navigate("/login");
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
  };

  if (!showWarning) return null;

  return (
    <AlertDialog open={showWarning} onOpenChange={() => {}}>
      <AlertDialogContent className="fixed inset-0 flex items-center justify-center">
        <AlertDialogHeader>
          <AlertDialogTitle>Sitzung läuft ab</AlertDialogTitle>
          <AlertDialogDescription>
            Ihre Sitzung läuft in <strong>{formatTime(remainingSeconds)}</strong> ab.
            Möchten Sie angemeldet bleiben?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={handleLogoutNow} data-testid="button-session-logout">
            Abmelden
          </Button>
          <Button onClick={handleKeepAlive} data-testid="button-session-keepalive">
            Angemeldet bleiben
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
