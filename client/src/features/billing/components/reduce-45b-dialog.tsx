import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { iconSize } from "@/design-system";
import { AlertTriangle, Loader2, Scissors } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem } from "@shared/api";
import { formatAmount } from "../utils";
import type { Reduce45bResponse, Reduce45bTargetPot } from "../types";

interface Reduce45bDialogProps {
  target: InvoiceItem | null;
  onOpenChange: (open: boolean) => void;
  mutation: UseMutationResult<
    Reduce45bResponse,
    Error,
    { id: number; paidCents: number; targetPot: Reduce45bTargetPot },
    unknown
  >;
}

// Ziel-Töpfe für den Überhang (X−Y). Reihenfolge = Vorschlagsreihenfolge in der
// UI; die Beträge/Regeln werden serverseitig (Cascade) durchgesetzt.
const TARGET_POT_OPTIONS: { value: Reduce45bTargetPot; label: string; hint: string }[] = [
  { value: "umwandlung_45a", label: "§45a (Umwandlung)", hint: "Umwandlungsanspruch — nur bis zum gesetzlichen Deckel." },
  { value: "ersatzpflege_39_42a", label: "§39 / §42a (Ersatz-/Verhinderungspflege)", hint: "Nur bis zum gesetzlichen Deckel des Ziel-Topfs." },
  { value: "private", label: "Privat (Selbstzahler, inkl. 19% MwSt.)", hint: "Kein Deckel — der Rest wird dem Kunden privat berechnet." },
];

// „12,34" oder „12.34" → 1234 Cent. Leere/ungültige Eingabe → null.
function parseEuroToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const euro = Number(cleaned);
  if (!Number.isFinite(euro) || euro < 0) return null;
  return Math.round(euro * 100);
}

export function Reduce45bDialog({ target, onOpenChange, mutation }: Reduce45bDialogProps) {
  const [paidEuro, setPaidEuro] = useState("");
  const [targetPot, setTargetPot] = useState<Reduce45bTargetPot | null>(null);

  // Beim Öffnen einer anderen Rechnung die Eingaben zurücksetzen.
  useEffect(() => {
    if (target) {
      setPaidEuro("");
      setTargetPot(null);
    }
  }, [target?.id]);

  const invoiceGrossCents = target?.grossAmountCents ?? 0;
  const paidCents = useMemo(() => parseEuroToCents(paidEuro), [paidEuro]);

  // Y muss 0 < Y < X sein (sonst gibt es nichts zu kürzen).
  const paidValid = paidCents !== null && paidCents > 0 && paidCents < invoiceGrossCents;
  const overflowCents =
    paidValid && paidCents !== null ? invoiceGrossCents - paidCents : 0;
  const canSubmit = paidValid && targetPot !== null && !mutation.isPending;

  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>§45b-Rechnung kürzen</AlertDialogTitle>
          <AlertDialogDescription>
            Die §45b-Rechnung{" "}
            <span className="font-medium">{target?.invoiceNumber}</span> wird auf den
            tatsächlich von der Pflegekasse gezahlten Betrag gekürzt. Der Überhang wird in
            einen Ziel-Topf umgebucht. Die Rechnung wird storniert und neu ausgestellt
            (GoBD-konform). Dieser Vorgang kann nicht rückgängig gemacht werden.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            <span className="text-gray-600">Aktueller §45b-Rechnungsbetrag (X)</span>
            <span className="font-medium tabular-nums" data-testid="text-reduce-45b-gross">
              {formatAmount(invoiceGrossCents)}
            </span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reduce-45b-paid">Tatsächlich gezahlt durch die Kasse (Y)</Label>
            <div className="relative">
              <Input
                id="reduce-45b-paid"
                inputMode="decimal"
                placeholder="z. B. 90,00"
                value={paidEuro}
                onChange={(e) => setPaidEuro(e.target.value)}
                className="pr-8"
                data-testid="input-reduce-45b-paid"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                €
              </span>
            </div>
            {paidEuro.trim() !== "" && !paidValid && (
              <p className="text-xs text-red-600" data-testid="text-reduce-45b-paid-error">
                Der gezahlte Betrag muss größer als 0 und kleiner als der
                Rechnungsbetrag ({formatAmount(invoiceGrossCents)}) sein.
              </p>
            )}
            {paidValid && (
              <p className="text-xs text-gray-600" data-testid="text-reduce-45b-overflow">
                Überhang (X−Y), der umgebucht wird:{" "}
                <span className="font-medium">{formatAmount(overflowCents)}</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Ziel-Topf für den Überhang</Label>
            <div className="flex flex-col gap-2">
              {TARGET_POT_OPTIONS.map((opt) => {
                const isActive = targetPot === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTargetPot(opt.value)}
                    className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? "border-teal-600 bg-teal-50 ring-1 ring-teal-600"
                        : "border-gray-200 bg-white hover:bg-gray-50"
                    }`}
                    aria-pressed={isActive}
                    data-testid={`button-reduce-45b-pot-${opt.value}`}
                  >
                    <span className="font-medium text-gray-900">{opt.label}</span>
                    <span className="block text-xs text-gray-500">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Task #1812 Re-Baseline-Hinweis: Der Startwert des Monats wird auf Y
              zurückgesetzt und ersetzt Akkumulation/Carryover ≤ diesem Monat. */}
          <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className={`${iconSize.sm} mt-0.5 shrink-0`} />
            <div className="space-y-1">
              <p className="font-medium">Wichtig — §45b-Startwert wird neu gesetzt</p>
              <p>
                Der §45b-Startwert dieses Monats wird auf den gezahlten Betrag
                zurückgesetzt und ersetzt die bisherige Ansammlung sowie Überträge bis zu
                diesem Monat. Eine ggf. bereits zugeordnete Kassen-Zahlung bleibt bestehen
                und muss nach dem Versand der neuen Rechnung manuell neu zugeordnet werden.
              </p>
            </div>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            className="bg-amber-600 hover:bg-amber-700"
            onClick={(e) => {
              // Der Dialog soll erst nach dem Mutations-Erfolg schließen (Toast/
              // Warnungen), daher das Default-Schließen unterbinden.
              e.preventDefault();
              if (target && paidValid && paidCents !== null && targetPot) {
                mutation.mutate({ id: target.id, paidCents, targetPot });
              }
            }}
            disabled={!canSubmit}
            data-testid="button-confirm-reduce-45b"
          >
            {mutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird gekürzt...
              </>
            ) : (
              <>
                <Scissors className={`${iconSize.sm} mr-1`} />
                Kürzen &amp; neu ausstellen
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
