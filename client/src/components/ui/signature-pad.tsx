import { useRef, useEffect, useState } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Button } from "./button";
import { Card, CardContent } from "./card";
import { Eraser, Check, X } from "lucide-react";
import { iconSize } from "@/design-system";
import { cn } from "@/lib/utils";

interface SignaturePadProps {
  onSave: (signatureData: string) => void;
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
  const signatureRef = useRef<SignatureCanvas>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 150 });

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth - 2;
        setCanvasSize({ width: Math.max(width, 280), height: 150 });
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const handleClear = () => {
    signatureRef.current?.clear();
    setIsEmpty(true);
  };

  const handleSave = () => {
    if (signatureRef.current && !isEmpty) {
      const canvas = signatureRef.current.getCanvas();
      const dataUrl = canvas.toDataURL("image/png");
      onSave(dataUrl);
    }
  };

  const handleBegin = () => {
    setIsEmpty(false);
  };

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

        <div
          ref={containerRef}
          className={cn(
            "border-2 border-dashed border-muted-foreground/30 rounded-lg bg-white relative",
            disabled && "opacity-50 pointer-events-none"
          )}
          style={{ minHeight: "150px", touchAction: "none" }}
        >
          <SignatureCanvas
            ref={signatureRef}
            penColor="black"
            canvasProps={{
              width: canvasSize.width,
              height: canvasSize.height,
              className: "rounded-lg",
              style: { touchAction: "none" },
            }}
            onBegin={handleBegin}
          />
          {isEmpty && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-muted-foreground/50 text-sm">
                Hier unterschreiben
              </span>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={disabled || isEmpty}
            data-testid="button-clear-signature"
          >
            <Eraser className={iconSize.sm} />
            <span className="ml-1">Löschen</span>
          </Button>
          {onCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={disabled}
              data-testid="button-cancel-signature"
            >
              <X className={iconSize.sm} />
              <span className="ml-1">Abbrechen</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={disabled || isEmpty}
            data-testid="button-save-signature"
          >
            <Check className={iconSize.sm} />
            <span className="ml-1">Bestätigen</span>
          </Button>
        </div>
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
    ? new Date(signedAt).toLocaleDateString("de-DE", {
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
