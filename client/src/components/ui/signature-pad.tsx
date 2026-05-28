import { useRef, useEffect, useState, useCallback } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Button } from "./button";
import { Card, CardContent } from "./card";
import { Eraser, Check, X, Pen, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SignatureMetadata {
  location?: { lat: number; lng: number };
}

/**
 * Task #752 — Mindestanzahl sichtbarer (nicht voll-transparenter) Pixel,
 * die wir als „echte Tinte auf dem Canvas" akzeptieren. Spiegelt die
 * Server-Heuristik aus `server/lib/signature-validation.ts`
 * (`MIN_SIGNATURE_INK_BYTES = 50`) wider: weniger Pixel ⇒ Canvas wirkt
 * leer und wir wollen den Server-Roundtrip mit `EMPTY_SIGNATURE` gar
 * nicht erst provozieren.
 */
export const MIN_SIGNATURE_INK_PIXELS = 50;

/**
 * Zählt Pixel mit Alpha > 0 auf einem Canvas. Wird sowohl reaktiv beim
 * Stroke-Ende verwendet (Button-Disable + Inline-Warnung) als auch
 * defensiv kurz vor `onSave`. Liefert 0 zurück, wenn `getImageData`
 * fehlschlägt (z.B. ohne 2D-Kontext im Test-Env) — der Save-Pfad
 * behandelt 0 wie „leer".
 */
export function countSignatureInkPixels(canvas: HTMLCanvasElement | null | undefined): number {
  if (!canvas) return 0;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return 0;
  }
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) count++;
  }
  return count;
}

interface SignaturePadProps {
  onSave: (signatureData: string, metadata?: SignatureMetadata) => void;
  onCancel?: () => void;
  title?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function SignaturePad({
  onSave,
  onCancel,
  title = "Unterschrift",
  description,
  disabled = false,
  className,
}: SignaturePadProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const signatureRef = useRef<SignatureCanvas>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [hasEnoughInk, setHasEnoughInk] = useState(false);
  const [showEmptyWarning, setShowEmptyWarning] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 300 });
  const locationRef = useRef<{ lat: number; lng: number } | undefined>(undefined);

  const recomputeInk = useCallback(() => {
    const canvas = signatureRef.current?.getCanvas();
    const pixels = countSignatureInkPixels(canvas);
    const enough = pixels >= MIN_SIGNATURE_INK_PIXELS;
    setHasEnoughInk(enough);
    if (enough) setShowEmptyWarning(false);
  }, []);

  const updateCanvasSize = useCallback(() => {
    if (!isFullscreen || !canvasContainerRef.current) return;
    const container = canvasContainerRef.current;
    const width = container.offsetWidth;
    const height = container.offsetHeight;
    setCanvasSize({ width: Math.max(width, 280), height: Math.max(height, 200) });
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;

    const raf = requestAnimationFrame(() => {
      updateCanvasSize();
    });

    window.addEventListener("resize", updateCanvasSize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateCanvasSize);
    };
  }, [isFullscreen, updateCanvasSize]);

  useEffect(() => {
    if (!isFullscreen) return;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    document.body.style.top = `-${window.scrollY}px`;
    const scrollY = window.scrollY;

    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.width = "";
      document.body.style.top = "";
      window.scrollTo(0, scrollY);
    };
  }, [isFullscreen]);

  const handleClear = () => {
    signatureRef.current?.clear();
    setIsEmpty(true);
    setHasEnoughInk(false);
    setShowEmptyWarning(false);
  };

  const handleSave = () => {
    if (!signatureRef.current) return;
    const canvas = signatureRef.current.getCanvas();
    const inkPixels = countSignatureInkPixels(canvas);
    if (inkPixels < MIN_SIGNATURE_INK_PIXELS) {
      // Task #752 — Spiegelt die Server-Validierung (EMPTY_SIGNATURE).
      // Statt einen 400-Roundtrip zu provozieren, blockieren wir hier
      // direkt und zeigen eine deutsche Inline-Warnung.
      setHasEnoughInk(false);
      setShowEmptyWarning(true);
      return;
    }
    const dataUrl = canvas.toDataURL("image/png");
    setIsFullscreen(false);
    const metadata: SignatureMetadata = {};
    if (locationRef.current) {
      metadata.location = locationRef.current;
    }
    onSave(dataUrl, Object.keys(metadata).length > 0 ? metadata : undefined);
  };

  const handleClose = () => {
    setIsFullscreen(false);
    setIsEmpty(true);
    setHasEnoughInk(false);
    setShowEmptyWarning(false);
    signatureRef.current?.clear();
    onCancel?.();
  };

  const handleBegin = () => {
    setIsEmpty(false);
    setShowEmptyWarning(false);
  };

  const handleEnd = () => {
    recomputeInk();
  };

  const openFullscreen = () => {
    if (!disabled) {
      setIsEmpty(true);
      setHasEnoughInk(false);
      setShowEmptyWarning(false);
      locationRef.current = undefined;
      setIsFullscreen(true);
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            locationRef.current = {
              lat: Math.round(pos.coords.latitude * 10000) / 10000,
              lng: Math.round(pos.coords.longitude * 10000) / 10000,
            };
          },
          () => {},
          { timeout: 10000, enableHighAccuracy: false }
        );
      }
    }
  };

  if (isFullscreen) {
    return (
      <div
        className="fixed inset-0 z-[100] bg-white flex flex-col"
        style={{ touchAction: "none" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-foreground truncate">{title}</h2>
            {description && (
              <p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">{description}</p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="ml-3 shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-gray-200 transition-colors"
            aria-label="Schließen"
            data-testid="button-close-signature-fullscreen"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div
          ref={canvasContainerRef}
          className="flex-1 relative bg-white"
          style={{ touchAction: "none" }}
        >
          <SignatureCanvas
            ref={signatureRef}
            penColor="black"
            minWidth={2}
            maxWidth={4}
            velocityFilterWeight={0.7}
            canvasProps={{
              width: canvasSize.width,
              height: canvasSize.height,
              className: "absolute inset-0",
              style: { touchAction: "none" },
            }}
            onBegin={handleBegin}
            onEnd={handleEnd}
          />

          <div className="absolute left-6 right-6 bottom-[30%] border-b-2 border-gray-300 pointer-events-none" />
          <div className="absolute left-6 bottom-[30%] -translate-y-2 pointer-events-none">
            <span className="text-xs text-gray-500 select-none">✕</span>
          </div>

          {isEmpty && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <Pen className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <span className="text-muted-foreground/50 text-lg font-medium">
                Hier unterschreiben
              </span>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-4 py-4 pb-safe">
          {showEmptyWarning && (
            <div
              className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              role="alert"
              data-testid="warning-empty-signature"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Bitte zuerst auf der Fläche unterschreiben.</span>
            </div>
          )}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              disabled={isEmpty}
              className="min-h-[52px] text-base px-5"
              data-testid="button-clear-signature"
            >
              <Eraser className="h-5 w-5 mr-2" />
              Löschen
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={isEmpty || !hasEnoughInk}
              className="flex-1 min-h-[52px] text-base font-semibold px-5"
              data-testid="button-save-signature"
            >
              <Check className="h-5 w-5 mr-2" />
              Unterschrift bestätigen
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardContent className="p-4 space-y-3">
        {(title || description) && (
          <div className="space-y-1">
            {title && (
              <h3 className="text-sm font-medium text-foreground">{title}</h3>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={openFullscreen}
          disabled={disabled}
          className={cn(
            "w-full border-2 border-dashed border-muted-foreground/30 rounded-lg bg-white",
            "flex flex-col items-center justify-center gap-2 py-8 cursor-pointer",
            "hover:border-primary/50 hover:bg-primary/5 transition-colors",
            "active:bg-primary/10",
            "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
            disabled && "opacity-50 pointer-events-none cursor-not-allowed"
          )}
          style={{ minHeight: "120px" }}
          data-testid="button-open-signature"
        >
          <Pen className="h-8 w-8 text-muted-foreground/50" />
          <span className="text-base text-muted-foreground font-medium">
            Tippen zum Unterschreiben
          </span>
        </button>

        {onCancel && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={disabled}
              data-testid="button-cancel-signature"
            >
              <X className="h-4 w-4 mr-1" />
              Abbrechen
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface SignatureDisplayProps {
  signatureData: string;
  label?: string;
  signedAt?: Date | string | null;
  className?: string;
}

export function SignatureDisplay({
  signatureData,
  label,
  signedAt,
  className,
}: SignatureDisplayProps) {
  const formattedDate = signedAt
    ? new Date(signedAt).toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      )}
      <div className="border rounded-lg p-2 bg-transparent relative">
        <img
          src={signatureData}
          alt="Unterschrift"
          className="max-h-36 w-auto mx-auto relative -mb-1"
          style={{ filter: "brightness(0) saturate(100%) invert(18%) sepia(60%) saturate(600%) hue-rotate(190deg)" }}
        />
        <div className="border-t border-gray-800 mx-2" />
      </div>
      {formattedDate && (
        <p className="text-xs text-muted-foreground text-center">
          Unterschrieben am {formattedDate}
        </p>
      )}
    </div>
  );
}
