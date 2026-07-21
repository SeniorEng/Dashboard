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
import { Loader2, Upload, Trash2, Eye, CheckCircle2, XCircle, FileText, AlertTriangle } from "lucide-react";
import { isExcelExponential } from "@shared/domain/qonto/avis-match";
import { formatCents, formatDate } from "../utils";
import { useQontoAdvices, useAdviceMutations } from "../hooks";
import type { PaymentAdviceItem } from "../types";

/** Task #1687 — Excel schreibt lange Belegnummern als `…E+11`. Solche Positionen
 * dürfen nicht still fehl-matchen; wir warnen an der Position. Prüft die rohen
 * Referenz-Felder (Beleg/Vorgang/Rechnungsnummer/Zweck). */
function hasExcelExponentialRef(item: PaymentAdviceItem): boolean {
  return [item.belegNr, item.vorgangsNr, item.rechnungsNummer, item.verwendungszweck]
    .some(v => !!v && isExcelExponential(v));
}

/** Eine einzelne Avis-Position (Task #1687: mit Excel-Format-Warnung + abgeleiteter
 * Positions-Unterzahlung). `position` ist die 1-basierte Original-Reihenfolge. */
function AdviceItemRow({ item, position }: { item: PaymentAdviceItem; position: number }) {
  const excelExp = hasExcelExponentialRef(item);
  const unterzahlung = item.unterzahlungCents ?? 0;
  const ueberzahlung = item.ueberzahlungCents ?? 0;
  return (
    <div
      className={`flex items-center justify-between gap-2 p-2 rounded text-sm ${
        item.matchedInvoiceId ? "bg-green-50" : "bg-amber-50"
      }`}
      data-testid={`advice-item-${item.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-gray-500">#{position}</span>
          {item.verwendungszweck && (
            <span className="text-sm truncate">{item.verwendungszweck}</span>
          )}
          {item.rechnungsNummer && (
            <span className="text-xs font-mono text-blue-600">{item.rechnungsNummer}</span>
          )}
          {excelExp && (
            <Badge
              variant="outline"
              className="text-xs bg-amber-100 text-amber-800 border-amber-300"
              data-testid={`badge-excel-exp-${item.id}`}
            >
              <AlertTriangle className="h-3 w-3 mr-1" />
              Excel-Format (…E+)
            </Badge>
          )}
        </div>
        {item.buchungsDatum && (
          <span className="text-xs text-gray-500">Buchung: {item.buchungsDatum}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {unterzahlung > 0 && (
          <Badge
            variant="outline"
            className="text-xs bg-red-50 text-red-700 border-red-200"
            data-testid={`badge-item-unterzahlung-${item.id}`}
          >
            −{formatCents(unterzahlung)}
          </Badge>
        )}
        {ueberzahlung > 0 && (
          <Badge
            variant="outline"
            className="text-xs bg-orange-50 text-orange-700 border-orange-200"
            data-testid={`badge-item-ueberzahlung-${item.id}`}
          >
            +{formatCents(ueberzahlung)}
          </Badge>
        )}
        <span className="font-medium text-sm">{formatCents(item.betragCents)}</span>
        {item.matchedInvoiceId ? (
          <CheckCircle2 className={`${iconSize.sm} text-green-600`} />
        ) : (
          <XCircle className={`${iconSize.sm} text-amber-500`} />
        )}
      </div>
    </div>
  );
}

export function AdvicesTab() {
  const { toast } = useToast();
  const { uploadFile } = useUpload();
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [duplicateDialog, setDuplicateDialog] = useState<{ open: boolean; message: string; pendingData: Record<string, unknown> | null }>({ open: false, message: "", pendingData: null });
  // Task #1687 — Fallback-Dialog: `1;`-Format strukturell nicht eindeutig ⇒ Nutzer
  // ordnet Betrag/Referenz/Datum manuell zu (kein stiller Barmer-Default).
  const [mappingDialog, setMappingDialog] = useState<{
    open: boolean;
    preview: string[][];
    betrag: number;
    referenz: number | null;
    datum: number | null;
    pendingData: Record<string, unknown> | null;
  }>({ open: false, preview: [], betrag: 0, referenz: null, datum: null, pendingData: null });

  const advicesQuery = useQontoAdvices();

  const { createMutation, deleteMutation, markPaidMutation } = useAdviceMutations({
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
      if (err instanceof ApiError && err.details?.avisUncertain) {
        const suggested = err.details.suggestedColumnMap as { betrag: number; referenz: number | null; datum: number | null } | null;
        setMappingDialog({
          open: true,
          preview: (err.details.preview as string[][]) ?? [],
          betrag: suggested?.betrag ?? 0,
          referenz: suggested?.referenz ?? null,
          datum: suggested?.datum ?? null,
          pendingData: payload,
        });
      } else if (err instanceof ApiError && err.details?.duplicate) {
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

  const closeMappingDialog = () =>
    setMappingDialog({ open: false, preview: [], betrag: 0, referenz: null, datum: null, pendingData: null });

  // Task #1687 — mit manuellem Spalten-Mapping erneut importieren.
  const handleMappingSubmit = async () => {
    const pending = mappingDialog.pendingData;
    if (!pending) return;
    const columnMap = { betrag: mappingDialog.betrag, referenz: mappingDialog.referenz, datum: mappingDialog.datum };
    closeMappingDialog();
    setUploading(true);
    try {
      await createMutation.mutateAsync({ ...pending, columnMap });
    } catch (err) {
      // Nach dem Mapping kann noch eine Doppelerfassung greifen → Mapping mitnehmen.
      if (err instanceof ApiError && err.details?.duplicate) {
        setDuplicateDialog({ open: true, message: err.message, pendingData: { ...pending, columnMap } });
      } else {
        toast({ title: "Fehler", description: err instanceof Error ? err.message : "Import fehlgeschlagen", variant: "destructive" });
      }
    } finally {
      setUploading(false);
    }
  };

  const mappingColumnCount = mappingDialog.preview.reduce((max, row) => Math.max(max, row.length), 0);
  const mappingColumnIndices = Array.from({ length: mappingColumnCount }, (_, i) => i);
  const mappingSelectClass = "w-full h-9 rounded-md border border-input bg-background px-2 text-sm";

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
      <AlertDialog open={mappingDialog.open} onOpenChange={(open) => { if (!open) closeMappingDialog(); }}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Spalten manuell zuordnen</AlertDialogTitle>
            <AlertDialogDescription>
              Das CSV-Format konnte nicht sicher erkannt werden. Bitte ordnen Sie anhand der Vorschau zu, in welchem Feld Betrag, Referenz und Datum stehen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mappingDialog.preview.length > 0 && (
            <div className="overflow-x-auto border rounded text-xs" data-testid="avis-mapping-preview">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50">
                    {mappingColumnIndices.map(i => (
                      <th key={i} className="px-2 py-1 text-left font-mono text-gray-500 whitespace-nowrap">Feld {i}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappingDialog.preview.map((row, r) => (
                    <tr key={r} className="border-t">
                      {mappingColumnIndices.map(i => (
                        <td key={i} className="px-2 py-1 whitespace-nowrap">{row[i] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="map-betrag">Betrag *</Label>
              <select
                id="map-betrag"
                className={mappingSelectClass}
                value={mappingDialog.betrag}
                onChange={(e) => setMappingDialog(m => ({ ...m, betrag: Number(e.target.value) }))}
                data-testid="select-map-betrag"
              >
                {mappingColumnIndices.map(i => (
                  <option key={i} value={i}>Feld {i}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="map-referenz">Referenz</Label>
              <select
                id="map-referenz"
                className={mappingSelectClass}
                value={mappingDialog.referenz ?? ""}
                onChange={(e) => setMappingDialog(m => ({ ...m, referenz: e.target.value === "" ? null : Number(e.target.value) }))}
                data-testid="select-map-referenz"
              >
                <option value="">—</option>
                {mappingColumnIndices.map(i => (
                  <option key={i} value={i}>Feld {i}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="map-datum">Datum</Label>
              <select
                id="map-datum"
                className={mappingSelectClass}
                value={mappingDialog.datum ?? ""}
                onChange={(e) => setMappingDialog(m => ({ ...m, datum: e.target.value === "" ? null : Number(e.target.value) }))}
                data-testid="select-map-datum"
              >
                <option value="">—</option>
                {mappingColumnIndices.map(i => (
                  <option key={i} value={i}>Feld {i}</option>
                ))}
              </select>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-mapping">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={handleMappingSubmit} data-testid="button-apply-mapping">Übernehmen &amp; importieren</AlertDialogAction>
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
            CSV-Dateien werden automatisch analysiert (DAVASO, Barmer, AOK). Rechnungen werden anhand der Rechnungsnummer zugeordnet – ersatzweise über den Betrag.
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
            const matchedItems = advice.items.filter(i => i.matchedInvoiceId);
            const unmatchedItems = advice.items.filter(i => !i.matchedInvoiceId);
            const matchedCount = matchedItems.length;
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
                        {/* Task #1822: Offener Rest statt eines nackten „Unterzahlung"-
                            Fehlers. Neutrale Formulierung, weil im Kassen-/Avis-Kontext
                            noch offen ist, ob der Rest eine echte Restforderung oder eine
                            endgültige Kürzung ist (die Topf-Umbuchung ist #1785, nicht #1822). */}
                        {(advice.unterzahlungCents ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="text-xs bg-cyan-50 text-cyan-700 border-cyan-200"
                            data-testid={`badge-advice-unterzahlung-${advice.id}`}
                          >
                            Rest {formatCents(advice.unterzahlungCents!)} offen
                          </Badge>
                        )}
                        {(advice.ueberzahlungCents ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="text-xs bg-orange-50 text-orange-700 border-orange-200"
                            data-testid={`badge-advice-ueberzahlung-${advice.id}`}
                          >
                            Überzahlung: {formatCents(advice.ueberzahlungCents!)}
                          </Badge>
                        )}
                      </div>
                      {advice.notes && (
                        <p className="text-xs text-gray-500 mt-0.5">{advice.notes}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {(advice.unpaidMatchedCount ?? 0) > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-green-700 border-green-200 hover:bg-green-50"
                          onClick={(e) => { e.stopPropagation(); markPaidMutation.mutate(advice.id); }}
                          disabled={markPaidMutation.isPending}
                          data-testid={`button-mark-paid-advice-${advice.id}`}
                        >
                          <CheckCircle2 className={`${iconSize.sm} mr-1`} />
                          Als bezahlt markieren
                        </Button>
                      )}
                      {advice.objectPath && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); window.open(advice.objectPath!, "_blank"); }}
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
                    <div className="mt-3 pt-3 border-t space-y-3">
                      {unmatchedItems.length > 0 && (
                        <div className="space-y-1.5" data-testid={`advice-unmatched-list-${advice.id}`}>
                          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
                            <AlertTriangle className={iconSize.sm} />
                            Nicht zugeordnet ({unmatchedItems.length})
                          </div>
                          {unmatchedItems.map(item => (
                            <AdviceItemRow
                              key={item.id}
                              item={item}
                              position={advice.items.indexOf(item) + 1}
                            />
                          ))}
                        </div>
                      )}
                      {matchedItems.length > 0 && (
                        <div className="space-y-1.5" data-testid={`advice-matched-list-${advice.id}`}>
                          <div className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                            <CheckCircle2 className={iconSize.sm} />
                            Zugeordnet ({matchedItems.length})
                          </div>
                          {matchedItems.map(item => (
                            <AdviceItemRow
                              key={item.id}
                              item={item}
                              position={advice.items.indexOf(item) + 1}
                            />
                          ))}
                        </div>
                      )}
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
