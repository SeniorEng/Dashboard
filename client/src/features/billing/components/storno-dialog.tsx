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
import { Ban, Loader2 } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { InvoiceItem } from "@shared/api";

interface StornoDialogProps {
  stornoTarget: InvoiceItem | null;
  onOpenChange: (open: boolean) => void;
  statusMutation: UseMutationResult<unknown, Error, { id: number; status: string }, unknown>;
}

export function StornoDialog({ stornoTarget, onOpenChange, statusMutation }: StornoDialogProps) {
  return (
    <AlertDialog open={!!stornoTarget} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rechnung stornieren?</AlertDialogTitle>
          <AlertDialogDescription>
            Die Rechnung <span className="font-medium">{stornoTarget?.invoiceNumber}</span> wird
            storniert und eine Stornorechnung wird automatisch erstellt. Dieser Vorgang kann nicht
            rückgängig gemacht werden.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            onClick={() => {
              if (stornoTarget) {
                statusMutation.mutate({ id: stornoTarget.id, status: "storniert" });
              }
            }}
            disabled={statusMutation.isPending}
            data-testid="button-confirm-storno"
          >
            {statusMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird storniert...
              </>
            ) : (
              <>
                <Ban className={`${iconSize.sm} mr-1`} />
                Stornieren
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
