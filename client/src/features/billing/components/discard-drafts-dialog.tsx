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
import type { BlockingDraftInvoice, DiscardDraftsResponse } from "@shared/api";

interface DiscardDraftsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blockingDrafts: BlockingDraftInvoice[] | undefined;
  previewCustomerId: number | null;
  selectedMonth: number;
  selectedYear: number;
  discardDraftsMutation: UseMutationResult<DiscardDraftsResponse, Error, { customerId: number; month: number; year: number }, unknown>;
}

export function DiscardDraftsDialog({
  open,
  onOpenChange,
  blockingDrafts,
  previewCustomerId,
  selectedMonth,
  selectedYear,
  discardDraftsMutation,
}: DiscardDraftsDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {blockingDrafts && blockingDrafts.length === 1 ? "Entwurf verwerfen?" : "Entwürfe verwerfen?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {blockingDrafts && blockingDrafts.length > 0 ? (
              <>
                {blockingDrafts.length === 1 ? "Der Entwurf " : "Die Entwürfe "}
                <span className="font-medium">
                  {blockingDrafts.map((d) => d.invoiceNumber).join(", ")}
                </span>
                {blockingDrafts.length === 1 ? " wird " : " werden "}
                endgültig gelöscht. Die zugehörigen Termine werden wieder frei und können neu
                abgerechnet werden. Nur unfertige Entwürfe sind betroffen — versendete oder bezahlte
                Rechnungen bleiben unberührt.
              </>
            ) : (
              "Es gibt keine verwaisten Entwürfe mehr zum Verwerfen."
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            onClick={() => {
              if (previewCustomerId !== null) {
                discardDraftsMutation.mutate({
                  customerId: previewCustomerId,
                  month: selectedMonth,
                  year: selectedYear,
                });
              }
            }}
            disabled={discardDraftsMutation.isPending}
            data-testid="button-confirm-discard-drafts"
          >
            {discardDraftsMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird verworfen...
              </>
            ) : (
              <>
                <Ban className={`${iconSize.sm} mr-1`} />
                Verwerfen
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
