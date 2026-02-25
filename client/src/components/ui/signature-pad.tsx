import { useRef, useEffect, useState, useCallback } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Button } from "./button";
import { Card, CardContent } from "./card";
import { Eraser, Check, X, Pen } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SignatureMetadata {
  location?: { lat: number; lng: number };
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
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 300 });
  const locationRef = useRef<{ lat: number; lng: number } | undefined>(undefined);

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
  };

  const handleSave = () => {
    if (signatureRef.current && !isEmpty) {
      const canvas = signatureRef.current.getCanvas();
      const dataUrl = canvas.toDataURL("image/png");
      setIsFullscreen(false);
      const metadata: SignatureMetadata = {};
      if (locationRef.current) {
        metadata.location = locationRef.current;
      }
      onSave(dataUrl, Object.keys(metadata).length > 0 ? metadata : undefined);
    }
  };

  const handleClose = () => {
    setIsFullscreen(false);
    setIsEmpty(true);
    signatureRef.current?.clear();
    onCancel?.();
  };

  const handleBegin = () => {
    setIsEmpty(false);
  };

  const openFullscreen = () => {
    if (!disabled) {
      setIsEmpty(true);
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
          />

          <div className="absolute left-6 right-6 bottom-[30%] border-b-2 border-gray-300 pointer-events-none" />
          <div className="absolute left-6 bottom-[30%] -translate-y-2 pointer-events-none">
            <span className="text-xs text-gray-400 select-none">✕</span>
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
              disabled={isEmpty}
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
      <div className="border rounded-lg bg-white p-2">
        <img
          src={signatureData}
          alt="Unterschrift"
          className="max-h-20 w-auto mx-auto"
        />
      </div>
      {formattedDate && (
        <p className="text-xs text-muted-foreground text-center">
          Unterschrieben am {formattedDate}
        </p>
      )}
    </div>
  );
}
