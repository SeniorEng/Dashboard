import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, Trash2, ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanySettings } from "@shared/schema";

interface LogoUploadCardProps {
  companyData: CompanySettings | undefined;
}

export function LogoUploadCard({ companyData }: LogoUploadCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfFileInputRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [pdfLogoUploading, setPdfLogoUploading] = useState(false);

  const createLogoUploadMutation = (field: "logoUrl" | "pdfLogoUrl", setUploading: (v: boolean) => void, label: string) =>
    useMutation({
      mutationFn: async (file: File) => {
        setUploading(true);
        const uploadRes = await api.post<{ uploadURL: string; objectPath: string; metadata: { name: string } }>(
          "/uploads/request-url",
          { name: file.name, size: file.size, contentType: file.type }
        );
        const uploadData = unwrapResult(uploadRes);

        await fetch(uploadData.uploadURL, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });

        const result = await api.patch<CompanySettings>("/company-settings", {
          [field]: uploadData.objectPath,
        });
        return unwrapResult(result);
      },
      onSuccess: (data) => {
        queryClient.setQueryData(["company-settings"], data);
        toast({ title: `${label} hochgeladen` });
        setUploading(false);
      },
      onError: (error: Error) => {
        toast({ title: `Fehler beim ${label}-Upload`, description: error.message, variant: "destructive" });
        setUploading(false);
      },
    });

  const createLogoDeleteMutation = (field: "logoUrl" | "pdfLogoUrl", label: string) =>
    useMutation({
      mutationFn: async () => {
        const result = await api.patch<CompanySettings>("/company-settings", { [field]: null });
        return unwrapResult(result);
      },
      onSuccess: (data) => {
        queryClient.setQueryData(["company-settings"], data);
        toast({ title: `${label} entfernt` });
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });

  const logoUploadMutation = createLogoUploadMutation("logoUrl", setLogoUploading, "App-Logo");
  const logoDeleteMutation = createLogoDeleteMutation("logoUrl", "App-Logo");
  const pdfLogoUploadMutation = createLogoUploadMutation("pdfLogoUrl", setPdfLogoUploading, "Dokumenten-Logo");
  const pdfLogoDeleteMutation = createLogoDeleteMutation("pdfLogoUrl", "Dokumenten-Logo");

  const handleLogoFileSelect = (e: React.ChangeEvent<HTMLInputElement>, mutation: typeof logoUploadMutation) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Nur Bilddateien erlaubt", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Datei zu groß (max. 2 MB)", variant: "destructive" });
      return;
    }

    mutation.mutate(file);
    e.target.value = "";
  };

  return (
    <Card data-testid="card-company-logos">
      <CardHeader>
        <CardTitle>Firmenlogos</CardTitle>
        <CardDescription>
          Zwei separate Logos: eines quadratisch für die App, eines für Dokumente und PDFs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid sm:grid-cols-2 gap-6">
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">App-Logo (quadratisch)</p>
            <p className="text-xs text-gray-500 mb-3">Wird links oben in der App angezeigt.</p>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                {companyData?.logoUrl ? (
                  <img
                    src={companyData.logoUrl}
                    alt="App-Logo"
                    width={64}
                    height={64}
                    className="w-full h-full object-contain p-1"
                    data-testid="img-company-logo"
                  />
                ) : (
                  <ImageIcon className="h-6 w-6 text-gray-500" />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => handleLogoFileSelect(e, logoUploadMutation)}
                  data-testid="input-logo-file"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={logoUploading}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="button-upload-logo"
                >
                  {logoUploading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {companyData?.logoUrl ? "Ändern" : "Hochladen"}
                </Button>
                {companyData?.logoUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={logoDeleteMutation.isPending}
                    onClick={() => logoDeleteMutation.mutate()}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 justify-start"
                    data-testid="button-delete-logo"
                  >
                    {logoDeleteMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Entfernen
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Dokumenten-Logo (PDF/Briefkopf)</p>
            <p className="text-xs text-gray-500 mb-3">Wird in Dokumenten, Verträgen und PDFs verwendet. Platzhalter: <code className="bg-gray-100 px-1 rounded text-xs">{"{{company_logo}}"}</code></p>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                {companyData?.pdfLogoUrl ? (
                  <img
                    src={companyData.pdfLogoUrl}
                    alt="Dokumenten-Logo"
                    width={64}
                    height={64}
                    className="w-full h-full object-contain p-1"
                    data-testid="img-pdf-logo"
                  />
                ) : (
                  <ImageIcon className="h-6 w-6 text-gray-500" />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input
                  ref={pdfFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => handleLogoFileSelect(e, pdfLogoUploadMutation)}
                  data-testid="input-pdf-logo-file"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pdfLogoUploading}
                  onClick={() => pdfFileInputRef.current?.click()}
                  data-testid="button-upload-pdf-logo"
                >
                  {pdfLogoUploading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {companyData?.pdfLogoUrl ? "Ändern" : "Hochladen"}
                </Button>
                {companyData?.pdfLogoUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pdfLogoDeleteMutation.isPending}
                    onClick={() => pdfLogoDeleteMutation.mutate()}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 justify-start"
                    data-testid="button-delete-pdf-logo"
                  >
                    {pdfLogoDeleteMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Entfernen
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-4">
          PNG, JPG, SVG oder WebP. Max. 2 MB pro Logo.
        </p>
      </CardContent>
    </Card>
  );
}
