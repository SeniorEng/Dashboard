export interface GenerateAllResponse {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: Array<{ customerId: number; status: "created" | "skipped" | "error"; invoiceCount?: number; message?: string }>;
}

// Task #1771: Reifegruppe des Split-Knopfs „Alle erstellen" auf der
// Abrechnungsseite. „all" = alle berechtigten Kunden (Bestandsverhalten),
// „ready" = nur Kunden ohne offene (geplante) Termine, „open" = nur Kunden mit
// noch offenen Terminen. Serverseitig über dieselbe „offene Termine"-SSoT
// gefiltert wie die Karten-Gruppierung „Noch zu erstellen".
export type BillingMaturityScope = "all" | "ready" | "open";
