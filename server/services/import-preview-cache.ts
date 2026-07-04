/**
 * Task #708 — Server-trusted Preview-State für Excel-Import & Reconcile.
 *
 * Hintergrund: Beide Execute-Pfade (`/import-appointments/execute` und
 * `/reconcile/execute`) waren stateless — sie haben den Cutoff aus den
 * vom Client gesendeten matchedRows abgeleitet. Ein manipulierter Client
 * konnte den Cutoff verschieben, indem er zusätzliche Zeilen jenseits des
 * ursprünglichen Excel-Bereichs in den Execute-Payload schmuggelte.
 *
 * Diese Cache speichert pro Preview-Aufruf den vertrauenswürdigen,
 * serverseitig aus der Original-Excel berechneten Cutoff sowie zulässige
 * Zeilen-/Termin-Identifier. Execute MUSS einen `previewToken` mitliefern,
 * der hier gegen den vorher gespeicherten Snapshot validiert wird.
 *
 * In-Memory mit kurzer TTL (15 Minuten) — bewusst nicht persistent, weil
 * Preview→Execute zeitnah passiert und ein Server-Neustart die Sicht
 * sowieso invalidiert.
 */
import { randomUUID } from "crypto";

const TTL_MS = 15 * 60 * 1000;

/**
 * Trusted per-Zeile-Daten aus dem Preview. Execute verifiziert ALLE
 * sicherheitsrelevanten Felder gegen diesen Snapshot — nicht nur Datum,
 * sondern auch existingAppointmentId, customerId, serviceId, employeeId
 * und status —, damit ein manipulierter Client nicht eine legitime
 * rowIndex/date-Kombination behalten und gleichzeitig den Mutations-Ziel-
 * Termin oder Kunden austauschen kann.
 */
export interface TrustedRowSnapshot {
  date: string;
  customerId: number | null;
  employeeId: number | null;
  serviceId: number | null;
  existingAppointmentId: number | null;
  status: "new" | "duplicate" | "upgrade" | "beyond_cutoff" | "error";
  /**
   * Task #1602: Bestandstermin ist bereits abgerechnet → Import darf ihn nicht
   * mutieren. Der Execute-Pfad lehnt eine `update`/`upgrade`-Aktion für eine
   * so markierte Zeile ab (Server-trusted, gegen Client-Manipulation).
   */
  billedProtected: boolean;
}

export interface ImportPreviewSnapshot {
  kind: "import";
  userId: number;
  excelCutoff: { lastDay: string; yearMonth: string } | null;
  /** Set aus rowIndex-Werten, die im Preview validiert wurden. */
  allowedRowIndexes: Set<number>;
  /** rowIndex → trusted per-Zeile-Daten aus dem Preview. */
  rows: Map<number, TrustedRowSnapshot>;
  /** Task #819: SHA-256 des hochgeladenen Datei-Puffers (Doppel-Import-Erkennung). */
  fileHash: string;
  /** Task #819: Original-Dateiname für das Import-Batch-Protokoll. */
  fileName: string | null;
  createdAt: number;
}

export interface ReconcilePreviewSnapshot {
  kind: "reconcile";
  userId: number;
  excelCutoff: { lastDay: string; yearMonth: string } | null;
  /** Set aus appointmentIds, die im Preview als cancellable markiert wurden. */
  allowedAppointmentIds: Set<number>;
  scopeCustomerIds: number[];
  scopeStartDate: string;
  scopeEndDate: string;
  createdAt: number;
}

type Snapshot = ImportPreviewSnapshot | ReconcilePreviewSnapshot;

const cache = new Map<string, Snapshot>();

function gc(): void {
  const now = Date.now();
  for (const [token, snap] of cache.entries()) {
    if (now - snap.createdAt > TTL_MS) cache.delete(token);
  }
}

export function storeImportPreview(
  userId: number,
  snapshot: Omit<ImportPreviewSnapshot, "kind" | "userId" | "createdAt">,
): string {
  gc();
  const token = randomUUID();
  cache.set(token, { kind: "import", userId, createdAt: Date.now(), ...snapshot });
  return token;
}

export function storeReconcilePreview(
  userId: number,
  snapshot: Omit<ReconcilePreviewSnapshot, "kind" | "userId" | "createdAt">,
): string {
  gc();
  const token = randomUUID();
  cache.set(token, { kind: "reconcile", userId, createdAt: Date.now(), ...snapshot });
  return token;
}

export function loadImportPreview(token: string, userId: number): ImportPreviewSnapshot | null {
  gc();
  const snap = cache.get(token);
  if (!snap || snap.kind !== "import" || snap.userId !== userId) return null;
  if (Date.now() - snap.createdAt > TTL_MS) {
    cache.delete(token);
    return null;
  }
  return snap;
}

export function loadReconcilePreview(token: string, userId: number): ReconcilePreviewSnapshot | null {
  gc();
  const snap = cache.get(token);
  if (!snap || snap.kind !== "reconcile" || snap.userId !== userId) return null;
  if (Date.now() - snap.createdAt > TTL_MS) {
    cache.delete(token);
    return null;
  }
  return snap;
}

export function consumePreview(token: string): void {
  cache.delete(token);
}
