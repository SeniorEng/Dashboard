import { Component, type ReactNode } from "react";
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

function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    error.message.includes("Failed to fetch dynamically imported module") ||
    error.message.includes("Loading chunk") ||
    error.message.includes("Loading CSS chunk")
  );
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

    if (isChunkLoadError(error)) {
      window.location.reload();
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[200px] flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
            <AlertTriangle className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Etwas ist schiefgelaufen</h2>
          <p className="text-muted-foreground text-sm mb-4 max-w-md">
            Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.
          </p>
          <Button onClick={this.handleReset} variant="outline">
            Erneut versuchen
          </Button>
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

    if (isChunkLoadError(error)) {
      window.location.reload();
    }
  }

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
            onClick={() => window.location.reload()}
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
