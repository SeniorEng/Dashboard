import { createHash } from "crypto";
import { db } from "./db";
import { customerCreationIdempotencyKeys, customers } from "@shared/schema";
import { and, eq, lt, sql } from "drizzle-orm";

const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type IdempotencyReservation =
  | { status: "hit"; customerId: number }
  | { status: "reserved"; reservationId: number }
  | { status: "conflict" }
  | { status: "in_progress" };

const RESERVATION_POLL_INTERVAL_MS = 100;
const RESERVATION_POLL_MAX_MS = 5000;

/**
 * Atomare Reservierung des Idempotency-Keys VOR der eigentlichen Kunden-
 * anlage. Verhindert die Race, dass zwei parallele Requests beide ein
 * "miss" sehen und beide einen Kunden anlegen.
 *
 *  - Erfolgreich eingefügt → `reserved` (Aufrufer legt Kunden an und ruft
 *    danach `finalizeIdempotencyReservation`).
 *  - Bereits vorhanden mit gleichem payloadHash und befüllter customerId
 *    → `hit` (idempotente Wiederholung).
 *  - Bereits vorhanden mit gleichem payloadHash, aber noch ohne
 *    customerId → es läuft ein paralleler Request; wir pollen kurz auf
 *    Befüllung. Bei Timeout: `conflict` (Aufrufer signalisiert Retry).
 *  - Bereits vorhanden mit abweichendem payloadHash → `conflict`
 *    (IDEMPOTENCY_KEY_REUSED).
 */
export async function reserveIdempotencyKey(
  idempotencyKey: string,
  payloadHash: string,
  userId: number | null,
): Promise<IdempotencyReservation> {
  // Best-effort cleanup expired rows (allows reuse of a long-expired key).
  await db.delete(customerCreationIdempotencyKeys)
    .where(lt(customerCreationIdempotencyKeys.expiresAt, new Date()))
    .catch(() => undefined);

  const expiresAt = new Date(Date.now() + IDEM_TTL_MS);
  const inserted = await db.insert(customerCreationIdempotencyKeys).values({
    idempotencyKey,
    payloadHash,
    customerId: null,
    createdByUserId: userId,
    expiresAt,
  }).onConflictDoNothing().returning({ id: customerCreationIdempotencyKeys.id });

  if (inserted.length > 0) {
    return { status: "reserved", reservationId: inserted[0].id };
  }

  // Conflict path: untersuche bestehende Reservierung.
  const start = Date.now();
  while (true) {
    const [row] = await db.select()
      .from(customerCreationIdempotencyKeys)
      .where(eq(customerCreationIdempotencyKeys.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) {
      // Race: Reservierung wurde zwischen Insert-Versuch und Select gelöscht
      // (z.B. wegen Cleanup oder Cleanup-After-Failure). Erneuter Versuch.
      const retry = await db.insert(customerCreationIdempotencyKeys).values({
        idempotencyKey,
        payloadHash,
        customerId: null,
        createdByUserId: userId,
        expiresAt,
      }).onConflictDoNothing().returning({ id: customerCreationIdempotencyKeys.id });
      if (retry.length > 0) return { status: "reserved", reservationId: retry[0].id };
      // Falls weiterhin nicht möglich, weiter pollen.
    } else {
      if (row.payloadHash !== payloadHash) return { status: "conflict" };
      if (row.customerId !== null) return { status: "hit", customerId: row.customerId };
    }
    if (Date.now() - start >= RESERVATION_POLL_MAX_MS) {
      // Gleicher Key+Payload, aber paralleler Erstrequest läuft noch.
      // Eigener Status `in_progress`, damit der Aufrufer dies vom echten
      // Konflikt (abweichender Payload-Hash) unterscheiden kann.
      return { status: "in_progress" };
    }
    await new Promise((r) => setTimeout(r, RESERVATION_POLL_INTERVAL_MS));
  }
}

/** Schreibt die customerId in eine zuvor reservierte Idempotency-Zeile. */
export async function finalizeIdempotencyReservation(
  reservationId: number,
  customerId: number,
): Promise<void> {
  await db.update(customerCreationIdempotencyKeys)
    .set({ customerId })
    .where(eq(customerCreationIdempotencyKeys.id, reservationId));
}

/** Räumt eine Reservierung auf, wenn die Kundenanlage fehlgeschlagen ist. */
export async function releaseIdempotencyReservation(reservationId: number): Promise<void> {
  await db.delete(customerCreationIdempotencyKeys)
    .where(eq(customerCreationIdempotencyKeys.id, reservationId))
    .catch(() => undefined);
}

const RECENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export interface RecentDuplicateInfo {
  id: number;
  vorname: string | null;
  nachname: string | null;
  createdAt: Date;
  ageMs: number;
}

/**
 * Sucht aktive Duplikate (gleicher Vor-/Nachname, optional Geburtsdatum),
 * die in den letzten 10 Minuten erstellt wurden. Wird zusätzlich zum
 * regulären Duplicate-Check geprüft, wenn `skipDuplicateCheck=true` aber
 * `acknowledgeRecentDuplicate` nicht gesetzt ist (Task #376 Schritt 2).
 */
export async function findRecentDuplicates(
  vorname: string,
  nachname: string,
  geburtsdatum?: string | null,
): Promise<RecentDuplicateInfo[]> {
  const v = vorname.trim();
  const n = nachname.trim();
  if (!v || !n) return [];
  const cutoff = new Date(Date.now() - RECENT_DUPLICATE_WINDOW_MS);
  const conds = [
    sql`LOWER(${customers.vorname}) = LOWER(${v})`,
    sql`LOWER(${customers.nachname}) = LOWER(${n})`,
    sql`${customers.deletedAt} IS NULL`,
    sql`${customers.createdAt} >= ${cutoff}`,
  ];
  if (geburtsdatum) {
    conds.push(eq(customers.geburtsdatum, geburtsdatum));
  }
  const rows = await db.select({
    id: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
    createdAt: customers.createdAt,
  })
    .from(customers)
    .where(and(...conds))
    .limit(5);
  const now = Date.now();
  return rows.map(r => ({
    ...r,
    ageMs: now - r.createdAt.getTime(),
  }));
}
