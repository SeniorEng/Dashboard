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
import { iconSize } from "@/design-system";
import { Banknote, Loader2 } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem } from "@shared/api";

interface MarkPaidDialogProps {
  // Task #1317: „Bezahlt" ist eine bewusste, endgültige Aktion — sie läuft nur
  // über diesen Bestätigungsdialog, damit „versendet" nie still zu „bezahlt"
  // wird.
  markPaidTarget: InvoiceItem | null;
  onOpenChange: (open: boolean) => void;
  statusMutation: UseMutationResult<unknown, Error, { id: number; status: string }, unknown>;
}

export function MarkPaidDialog({ markPaidTarget, onOpenChange, statusMutation }: MarkPaidDialogProps) {
  return (
    <AlertDialog open={!!markPaidTarget} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Als bezahlt markieren?</AlertDialogTitle>
          <AlertDialogDescription>
            Die Rechnung <span className="font-medium">{markPaidTarget?.invoiceNumber}</span> wird
            endgültig als <span className="font-medium">bezahlt</span> markiert. Bitte nur
            bestätigen, wenn der Zahlungseingang tatsächlich vorliegt.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            className="bg-green-600 hover:bg-green-700"
            onClick={() => {
              if (markPaidTarget) {
                statusMutation.mutate({ id: markPaidTarget.id, status: "bezahlt" });
              }
            }}
            disabled={statusMutation.isPending}
            data-testid="button-confirm-paid"
          >
            {statusMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird markiert...
              </>
            ) : (
              <>
                <Banknote className={`${iconSize.sm} mr-1`} />
                Als bezahlt markieren
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
