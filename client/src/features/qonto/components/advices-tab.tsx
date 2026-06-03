import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api";
import { useUpload } from "@/hooks/use-upload";
import { iconSize } from "@/design-system";
import { Loader2, Upload, Trash2, Eye, CheckCircle2, XCircle, FileText } from "lucide-react";
import { formatCents, formatDate } from "../utils";
import { useQontoAdvices, useAdviceMutations } from "../hooks";

export function AdvicesTab() {
  const { toast } = useToast();
  const { uploadFile } = useUpload();
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [duplicateDialog, setDuplicateDialog] = useState<{ open: boolean; message: string; pendingData: Record<string, unknown> | null }>({ open: false, message: "", pendingData: null });

  const advicesQuery = useQontoAdvices();

  const { createMutation, deleteMutation } = useAdviceMutations({
    onCreateSuccess: () => setNotes(""),
  });

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const csvContent = await file.text();
    const payload: Record<string, unknown> = {
      csvContent,
      fileName: file.name,
      notes: notes || null,
    };
    try {
      await createMutation.mutateAsync(payload);
    } catch (err) {
      if (err instanceof ApiError && err.details?.duplicate) {
        setDuplicateDialog({
          open: true,
          message: err.message,
          pendingData: payload,
        });
      } else {
        toast({ title: "Fehler", description: err instanceof Error ? err.message : "CSV konnte nicht verarbeitet werden", variant: "destructive" });
      }
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    let uploadedObjectPath: string | null = null;
    try {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");
      uploadedObjectPath = uploadResult.objectPath;

      const payload: Record<string, unknown> = {
        objectPath: uploadedObjectPath,
        fileName: file.name,
        notes: notes || null,
      };
      await createMutation.mutateAsync(payload);
    } catch (err) {
      if (err instanceof ApiError && err.details?.duplicate && uploadedObjectPath) {
        setDuplicateDialog({
          open: true,
          message: err.message,
          pendingData: { objectPath: uploadedObjectPath, fileName: file.name, notes: notes || null },
        });
      } else {
        toast({ title: "Fehler", description: err instanceof Error ? err.message : "Upload fehlgeschlagen", variant: "destructive" });
      }
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleForceCreate = async () => {
    if (!duplicateDialog.pendingData) return;
    setDuplicateDialog({ open: false, message: "", pendingData: null });
    setUploading(true);
    try {
      await createMutation.mutateAsync({ ...duplicateDialog.pendingData, force: true });
    } catch (err) {
      toast({ title: "Fehler", description: err instanceof Error ? err.message : "Speichern fehlgeschlagen", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const advices = advicesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <AlertDialog open={duplicateDialog.open} onOpenChange={(open) => { if (!open) setDuplicateDialog({ open: false, message: "", pendingData: null }); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mögliche Doppelerfassung</AlertDialogTitle>
            <AlertDialogDescription>
              {duplicateDialog.message || "Ein ähnlicher Zahlungsavis existiert bereits."} Möchten Sie die Datei trotzdem importieren?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-duplicate">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={handleForceCreate} data-testid="button-force-save">Trotzdem speichern</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className={iconSize.sm} />
            Zahlungsavis importieren
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-500">
            CSV-Dateien werden automatisch analysiert (DAVASO, Barmer). Rechnungen werden anhand der Rechnungsnummer zugeordnet.
          </p>
          <div>
            <Label htmlFor="advice-notes-new">Notizen (optional)</Label>
            <Input
              id="advice-notes-new"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="z.B. Februar-Abrechnung"
              data-testid="input-advice-notes"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="advice-csv">CSV importieren</Label>
              <Input
                id="advice-csv"
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                disabled={uploading}
                className="mt-1"
                data-testid="input-advice-csv"
              />
            </div>
            <div>
              <Label htmlFor="advice-pdf">Oder PDF hochladen</Label>
              <Input
                id="advice-pdf"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={handlePdfUpload}
                disabled={uploading}
                className="mt-1"
                data-testid="input-advice-pdf"
              />
            </div>
          </div>
          {uploading && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className={`${iconSize.sm} animate-spin`} />
              Wird verarbeitet...
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {advicesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
          </div>
        ) : advices.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-gray-500">
              Noch keine Zahlungsavise importiert.
            </CardContent>
          </Card>
        ) : (
          advices.map(advice => {
            const isExpanded = expandedId === advice.id;
            const matchedCount = advice.items.filter(i => i.matchedInvoiceId).length;
            const totalItems = advice.items.length;
            const isParsed = advice.format !== "manuell";

            return (
              <Card key={advice.id} data-testid={`advice-card-${advice.id}`}>
                <CardContent className="p-4">
                  <div
                    className="flex items-center justify-between gap-2 cursor-pointer"
                    onClick={() => isParsed && setExpandedId(isExpanded ? null : advice.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <FileText className={`${iconSize.sm} text-gray-500 shrink-0`} />
                        <span className="font-medium text-sm">
                          {advice.kostentraegerName || advice.insuranceProviderName || advice.fileName}
                        </span>
                        {isParsed && (
                          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                            {advice.format.toUpperCase()}
                          </Badge>
                        )}
                        {advice.gesamtBetragCents != null && (
                          <span className="font-semibold text-sm text-green-700">
                            {formatCents(advice.gesamtBetragCents)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {advice.zahlungsDatum && (
                          <span className="text-xs text-gray-500">Zahlung: {formatDate(advice.zahlungsDatum)}</span>
                        )}
                        {advice.kostentraegerIk && (
                          <span className="text-xs text-gray-500">IK: {advice.kostentraegerIk}</span>
                        )}
                        {advice.belegNummer && (
                          <span className="text-xs text-gray-500">Beleg: {advice.belegNummer}</span>
                        )}
                        {advice.avisNummer && (
                          <span className="text-xs text-gray-500">Avis: {advice.avisNummer}</span>
                        )}
                        {isParsed && totalItems > 0 && (
                          <Badge
                            variant="outline"
                            className={`text-xs ${matchedCount === totalItems
                              ? "bg-green-50 text-green-700 border-green-200"
                              : "bg-amber-50 text-amber-700 border-amber-200"
                            }`}
                          >
                            {matchedCount}/{totalItems} zugeordnet
                          </Badge>
                        )}
                        {(advice.skontoCents > 0 || advice.kuerzungCents > 0) && (
                          <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                            {advice.skontoCents > 0 ? `Skonto: ${formatCents(advice.skontoCents)}` : ""}
                            {advice.skontoCents > 0 && advice.kuerzungCents > 0 ? " / " : ""}
                            {advice.kuerzungCents > 0 ? `Kürzung: ${formatCents(advice.kuerzungCents)}` : ""}
                          </Badge>
                        )}
                      </div>
                      {advice.notes && (
                        <p className="text-xs text-gray-500 mt-0.5">{advice.notes}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {advice.objectPath && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); window.open(`/api/object-storage/download?path=${encodeURIComponent(advice.objectPath!)}`, "_blank"); }}
                          aria-label="PDF anzeigen"
                          data-testid={`button-view-advice-${advice.id}`}
                        >
                          <Eye className={iconSize.sm} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(advice.id); }}
                        disabled={deleteMutation.isPending}
                        aria-label="Avis löschen"
                        data-testid={`button-delete-advice-${advice.id}`}
                      >
                        <Trash2 className={iconSize.sm} />
                      </Button>
                    </div>
                  </div>

                  {isExpanded && advice.items.length > 0 && (
                    <div className="mt-3 pt-3 border-t">
                      <div className="space-y-1.5">
                        {advice.items.map((item, idx) => (
                          <div
                            key={item.id}
                            className={`flex items-center justify-between gap-2 p-2 rounded text-sm ${
                              item.matchedInvoiceId ? "bg-green-50" : "bg-amber-50"
                            }`}
                            data-testid={`advice-item-${item.id}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-mono text-gray-500">#{idx + 1}</span>
                                {item.verwendungszweck && (
                                  <span className="text-sm truncate">{item.verwendungszweck}</span>
                                )}
                                {item.rechnungsNummer && (
                                  <span className="text-xs font-mono text-blue-600">
                                    {item.rechnungsNummer}
                                  </span>
                                )}
                              </div>
                              {item.buchungsDatum && (
                                <span className="text-xs text-gray-500">Buchung: {item.buchungsDatum}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-medium text-sm">{formatCents(item.betragCents)}</span>
                              {item.matchedInvoiceId ? (
                                <CheckCircle2 className={`${iconSize.sm} text-green-600`} />
                              ) : (
                                <XCircle className={`${iconSize.sm} text-amber-500`} />
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
