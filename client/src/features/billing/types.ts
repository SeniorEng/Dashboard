export interface GenerateAllResponse {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: Array<{ customerId: number; status: "created" | "skipped" | "error"; invoiceCount?: number; message?: string }>;
}

// Task #1785 P4 — §45b-Kürzung. Ziel-Topf, in den der Überhang (X−Y) umgebucht
// wird. Spiegelt `Reduce45bTargetPot` des Servers (SSoT: invoice-45b-reduction).
export type Reduce45bTargetPot = "umwandlung_45a" | "ersatzpflege_39_42a" | "private";

// Antwort von `POST /billing/:id/reduce-45b`. Der Server liefert das Ergebnis
// direkt (kein Wrapper) — spiegelt `Reduce45bInvoiceResult`. `reissue`/`warnings`
// werden bewusst SEPARAT vom committeten Storno/Re-Baseline gemeldet: scheitert
// die Re-Rechnung, ist der Ledger bereits korrekt und der Aufruf ist über die
// normale Rechnungserstellung wiederholbar.
export interface Reduce45bResponse {
  customerId: number;
  billingMonth: number;
  billingYear: number;
  paidCents: number;
  invoiceGrossCents: number;
  overflowCents: number;
  targetPot: Reduce45bTargetPot;
  rebooked45bCents: number;
  storno: {
    stornoInvoiceId: number;
    stornoInvoiceNumber: string;
    cascadeStornoIds: number[];
  };
  reissue:
    | { ok: true; invoiceIds: number[]; new45bInvoiceId: number | null; message?: string }
    | { ok: false; error: string };
  warnings: string[];
}
