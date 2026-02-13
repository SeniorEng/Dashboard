import { useRef, useState, useCallback, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { FileText, Check, AlertCircle, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingType } from "@shared/domain/customers";

interface TemplateWithRequirement {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  requirement: string;
  sortOrder: number;
}

interface SignaturesStepProps {
  billingType: BillingType;
  customerSignatures: Record<string, string>;
  onSignatureChange: (slug: string, signatureData: string) => void;
}

function SignatureCanvas({
  slug,
  onSave,
  existingSignature,
}: {
  slug: string;
  onSave: (data: string) => void;
  existingSignature?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(!!existingSignature);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (existingSignature) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.offsetWidth, canvas.offsetHeight);
      };
      img.src = existingSignature;
    }
  }, []);

  const getPos = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ("touches" in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    }
    return {
      x: (e as React.MouseEvent).clientX - rect.left,
      y: (e as React.MouseEvent).clientY - rect.top,
    };
  }, []);

  const startDrawing = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setIsDrawing(true);
    setHasContent(true);
  }, [getPos]);

  const draw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }, [isDrawing, getPos]);

  const stopDrawing = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      onSave(canvas.toDataURL("image/png"));
    }
  }, [isDrawing, onSave]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    onSave("");
  }, [onSave]);

  return (
    <div className="space-y-2">
      <div className="relative border-2 border-dashed border-gray-300 rounded-lg bg-white">
        <canvas
          ref={canvasRef}
          className="w-full touch-none cursor-crosshair"
          style={{ height: "120px" }}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          data-testid={`canvas-signature-${slug}`}
        />
        {!hasContent && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-gray-400">Hier unterschreiben</p>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearCanvas}
          className="text-xs text-gray-500"
          data-testid={`button-clear-signature-${slug}`}
        >
          Löschen
        </Button>
      </div>
    </div>
  );
}

export function SignaturesStep({ billingType, customerSignatures, onSignatureChange }: SignaturesStepProps) {
  const { data: templates, isLoading } = useQuery({
    queryKey: ["/api/customers/document-templates/billing-type", billingType],
    queryFn: async () => {
      const result = await api.get<TemplateWithRequirement[]>(
        `/customers/document-templates/billing-type/${billingType}`
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
      </div>
    );
  }

  const pflichtDocs = templates?.filter(t => t.requirement === "pflicht") || [];
  const optionalDocs = templates?.filter(t => t.requirement === "optional") || [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Folgende Dokumente müssen vom Kunden unterschrieben werden. Pflichtdokumente sind markiert.
      </p>

      {pflichtDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            Pflichtdokumente
          </h3>
          {pflichtDocs.map((doc) => (
            <DocumentSignatureCard
              key={doc.slug}
              doc={doc}
              signature={customerSignatures[doc.slug]}
              onSignatureChange={(data) => onSignatureChange(doc.slug, data)}
            />
          ))}
        </div>
      )}

      {optionalDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">
            Optionale Dokumente
          </h3>
          {optionalDocs.map((doc) => (
            <DocumentSignatureCard
              key={doc.slug}
              doc={doc}
              signature={customerSignatures[doc.slug]}
              onSignatureChange={(data) => onSignatureChange(doc.slug, data)}
            />
          ))}
        </div>
      )}

      <div className="p-3 bg-teal-50 border border-teal-100 rounded-lg">
        <p className="text-xs text-teal-800">
          Unterschriften können auch nachträglich in der Kundenansicht unter "Dokumente" erfasst werden.
          Der Kunde kann trotzdem angelegt werden.
        </p>
      </div>
    </div>
  );
}

function DocumentSignatureCard({
  doc,
  signature,
  onSignatureChange,
}: {
  doc: TemplateWithRequirement;
  signature?: string;
  onSignatureChange: (data: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isSigned = !!signature;

  return (
    <Card
      className={`transition-colors ${isSigned ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}
      data-testid={`signature-doc-${doc.slug}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-full shrink-0 ${
            isSigned ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"
          }`}>
            {isSigned ? <Check className={iconSize.md} /> : <FileText className={iconSize.md} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-gray-900">{doc.name}</h4>
              <Badge
                variant={doc.requirement === "pflicht" ? "destructive" : "secondary"}
                className="text-[10px] px-1.5 py-0"
              >
                {doc.requirement === "pflicht" ? "Pflicht" : "Optional"}
              </Badge>
              {isSigned && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-green-600">
                  Unterschrieben
                </Badge>
              )}
            </div>
            {doc.description && (
              <p className="text-sm text-gray-500 mt-1">{doc.description}</p>
            )}

            <div className="mt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-xs"
                data-testid={`button-sign-${doc.slug}`}
              >
                {isExpanded ? "Ausblenden" : isSigned ? "Unterschrift ändern" : "Unterschreiben"}
              </Button>
            </div>

            {isExpanded && (
              <div className="mt-3">
                <SignatureCanvas
                  slug={doc.slug}
                  onSave={onSignatureChange}
                  existingSignature={signature}
                />
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
