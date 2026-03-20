import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Mail, Upload, Trash2, Paperclip, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import type { CompanySettings } from "@shared/schema";
import type { CompanyFormData } from "./types";

interface LeadAutoReplyCardProps {
  companyForm: CompanyFormData;
  companyData: CompanySettings | undefined;
  updateField: (field: keyof CompanyFormData, value: string | boolean) => void;
  companySaveMutation: { mutateAsync: (data: CompanyFormData) => Promise<unknown> };
}

export function LeadAutoReplyCard({ companyForm, companyData, updateField, companySaveMutation }: LeadAutoReplyCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setUploading(true);
      const uploadRes = await api.post<{ uploadURL: string; objectPath: string; metadata: { name: string } }>(
        "/uploads/request-url",
        { name: file.name, size: file.size, contentType: file.type }
      );
      const uploadData = unwrapResult(uploadRes);

      const putResponse = await fetch(uploadData.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!putResponse.ok) {
        throw new Error("Datei konnte nicht hochgeladen werden");
      }

      const result = await api.patch<CompanySettings>("/company-settings", {
        leadAutoReplyAttachmentPath: uploadData.objectPath,
        leadAutoReplyAttachmentName: file.name,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      updateField("leadAutoReplyAttachmentPath", (data as CompanySettings).leadAutoReplyAttachmentPath || "");
      updateField("leadAutoReplyAttachmentName", (data as CompanySettings).leadAutoReplyAttachmentName || "");
      toast({ title: "PDF-Anhang hochgeladen" });
      setUploading(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Upload", description: error.message, variant: "destructive" });
      setUploading(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", {
        leadAutoReplyAttachmentPath: null,
        leadAutoReplyAttachmentName: null,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      updateField("leadAutoReplyAttachmentPath", "");
      updateField("leadAutoReplyAttachmentName", "");
      toast({ title: "PDF-Anhang entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      toast({ title: "Nur PDF-Dateien erlaubt", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Datei zu groß (max. 10 MB)", variant: "destructive" });
      return;
    }

    uploadMutation.mutate(file);
    e.target.value = "";
  };

  const attachmentName = companyForm.leadAutoReplyAttachmentName || companyData?.leadAutoReplyAttachmentName;

  return (
    <Card data-testid="card-lead-auto-reply">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          Automatische Antwort bei Kundenanfrage
        </CardTitle>
        <CardDescription>
          Sendet automatisch eine formatierte E-Mail mit optionalem PDF-Anhang (z.B. Infobroschüre) an den Interessenten, sobald eine neue Anfrage eingeht.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="auto-reply-toggle" className="text-base font-medium">
              Automatische Antwort aktiviert
            </Label>
            <Switch
              id="auto-reply-toggle"
              data-testid="switch-lead-auto-reply"
              checked={companyForm.leadAutoReplyEnabled}
              onCheckedChange={(checked) => updateField("leadAutoReplyEnabled", checked)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="leadAutoReplySubject">E-Mail-Betreff</Label>
            <Input
              id="leadAutoReplySubject"
              value={companyForm.leadAutoReplySubject}
              onChange={(e) => updateField("leadAutoReplySubject", e.target.value)}
              placeholder="z.B. Vielen Dank für Ihre Anfrage bei SeniorenEngel"
              data-testid="input-lead-auto-reply-subject"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="leadAutoReplyBody">E-Mail-Text</Label>
            <Textarea
              id="leadAutoReplyBody"
              value={companyForm.leadAutoReplyBody}
              onChange={(e) => updateField("leadAutoReplyBody", e.target.value)}
              placeholder={"vielen Dank für Ihr Interesse an unseren Dienstleistungen.\n\nWir haben Ihre Anfrage erhalten und werden uns schnellstmöglich bei Ihnen melden.\n\nAnbei finden Sie unsere Informationsbroschüre mit einer Übersicht unserer Leistungen."}
              rows={8}
              data-testid="input-lead-auto-reply-body"
            />
            <p className="text-xs text-muted-foreground">
              Anrede, Grußformel und Kontaktdaten werden automatisch ergänzt.
            </p>
          </div>

          <div className="space-y-2">
            <Label>PDF-Anhang (optional)</Label>
            <div className="flex items-center gap-3">
              {attachmentName ? (
                <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex-1 min-w-0">
                  <Paperclip className="h-4 w-4 text-blue-600 shrink-0" />
                  <span className="text-sm text-blue-800 truncate" data-testid="text-attachment-name">
                    {attachmentName}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-gray-50 border border-dashed border-gray-300 rounded-lg px-3 py-2 flex-1">
                  <Paperclip className="h-4 w-4 text-gray-400" />
                  <span className="text-sm text-gray-500">Kein Anhang hochgeladen</span>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={handleFileSelect}
                data-testid="input-auto-reply-attachment"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-auto-reply-attachment"
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {attachmentName ? "Ändern" : "PDF hochladen"}
              </Button>
              {attachmentName && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  data-testid="button-delete-auto-reply-attachment"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              PDF-Datei, max. 10 MB. Z.B. eine Informationsbroschüre oder Leistungsübersicht.
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            Einstellungen werden beim Speichern der Firmendaten mit gespeichert. Die E-Mail wird im Firmendesign versendet (Logo, Farben, Footer) und enthält automatisch Ihre Kontaktdaten.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
