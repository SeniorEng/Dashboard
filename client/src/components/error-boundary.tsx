import { Component, useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  pageName?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

const CHUNK_RELOAD_COUNT_KEY = "errorBoundary:chunkReloadCount";
const CHUNK_RELOAD_MAX_ATTEMPTS = 1;
const STABILITY_RESET_MS = 1000;

let errorBoundaryCaughtSinceMount = false;

function markErrorBoundaryCaught(): void {
  errorBoundaryCaughtSinceMount = true;
}

function clearErrorBoundaryCaughtFlag(): void {
  errorBoundaryCaughtSinceMount = false;
}

function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    error.message.includes("Failed to fetch dynamically imported module") ||
    error.message.includes("Loading chunk") ||
    error.message.includes("Loading CSS chunk")
  );
}

function readChunkReloadCount(): number {
  if (typeof window === "undefined" || !window.sessionStorage) return 0;
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_COUNT_KEY);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeChunkReloadCount(value: number): boolean {
  if (typeof window === "undefined" || !window.sessionStorage) return false;
  try {
    if (value <= 0) {
      window.sessionStorage.removeItem(CHUNK_RELOAD_COUNT_KEY);
    } else {
      window.sessionStorage.setItem(CHUNK_RELOAD_COUNT_KEY, String(value));
    }
    return true;
  } catch {
    return false;
  }
}

function resetChunkReloadCount(): void {
  writeChunkReloadCount(0);
}

function attemptChunkRecoveryReload(boundaryName: string): boolean {
  const current = readChunkReloadCount();
  if (current >= CHUNK_RELOAD_MAX_ATTEMPTS) {
    console.warn(
      `[${boundaryName}] ChunkLoadError persisted after ${current} auto-reload(s); showing error UI instead of looping.`,
    );
    return false;
  }
  const wrote = writeChunkReloadCount(current + 1);
  if (!wrote) {
    console.warn(
      `[${boundaryName}] ChunkLoadError, but sessionStorage is unavailable; skipping auto-reload to avoid an infinite loop.`,
    );
    return false;
  }
  console.warn(
    `[${boundaryName}] ChunkLoadError, attempting one self-recovery reload (attempt ${current + 1}/${CHUNK_RELOAD_MAX_ATTEMPTS}).`,
  );
  window.location.reload();
  return true;
}

export function useResetChunkReloadCountAfterStableRender(): void {
  useEffect(() => {
    clearErrorBoundaryCaughtFlag();
    const timer = window.setTimeout(() => {
      if (errorBoundaryCaughtSinceMount) {
        return;
      }
      resetChunkReloadCount();
    }, STABILITY_RESET_MS);
    return () => window.clearTimeout(timer);
  }, []);
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error?.message || String(error), error?.stack, errorInfo?.componentStack);
    markErrorBoundaryCaught();

    if (isChunkLoadError(error)) {
      attemptChunkRecoveryReload("ErrorBoundary");
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  handleReload = () => {
    resetChunkReloadCount();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isChunk = this.state.error ? isChunkLoadError(this.state.error) : false;

      return (
        <div className="min-h-[200px] flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
            <AlertTriangle className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Etwas ist schiefgelaufen</h2>
          <p className="text-muted-foreground text-sm mb-4 max-w-md">
            {isChunk
              ? "Beim Nachladen eines App-Teils ist ein Fehler aufgetreten. Bitte laden Sie die Seite neu."
              : "Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut."}
          </p>
          {isChunk ? (
            <Button onClick={this.handleReload} variant="default" data-testid="button-error-reload">
              Seite neu laden
            </Button>
          ) : (
            <Button onClick={this.handleReset} variant="outline">
              Erneut versuchen
            </Button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export class PageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[PageErrorBoundary]", this.props.pageName || "", error?.message || String(error), error?.stack, errorInfo?.componentStack);
    markErrorBoundaryCaught();

    if (isChunkLoadError(error)) {
      attemptChunkRecoveryReload("PageErrorBoundary");
    }
  }

  handleReload = () => {
    resetChunkReloadCount();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
          <div className="w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center mb-6">
            <AlertTriangle className="w-10 h-10 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2" data-testid="text-page-error-title">
            {this.props.pageName
              ? `Fehler beim Laden: ${this.props.pageName}`
              : "Seite konnte nicht geladen werden"}
          </h2>
          <p className="text-muted-foreground text-sm mb-6 max-w-md" data-testid="text-page-error-description">
            Es ist ein unerwarteter Fehler aufgetreten. Bitte laden Sie die Seite neu.
          </p>
          <Button
            onClick={this.handleReload}
            variant="default"
            size="lg"
            data-testid="button-page-reload"
          >
            Seite neu laden
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
