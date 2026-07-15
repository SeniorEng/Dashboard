export interface GenerateAllResponse {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: Array<{ customerId: number; status: "created" | "skipped" | "error"; invoiceCount?: number; message?: string }>;
}

