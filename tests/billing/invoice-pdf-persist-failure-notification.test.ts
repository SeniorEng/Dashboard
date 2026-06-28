/**
 * Task #1468 — Aktive Benachrichtigung bei endgültigem PDF-Persist-Fehlschlag.
 *
 * Wenn alle Hintergrund-Persist-Versuche für ein Rechnungs-PDF scheitern, wird
 * bislang nur ein `invoice_pdf_persist_failed`-Audit-Eintrag geschrieben — der
 * Fehler fällt erst auf, wenn jemand die „PDF-Fehler"-Badge in der Abrechnung
 * sieht. `notifySuperadminsOfPdfFailure` erzeugt zusätzlich eine aktive In-App-
 * Benachrichtigung an alle aktiven Superadmins, die Rechnungsnummer UND
 * Fehlergrund nennt und pro Rechnung innerhalb von 24h nur einmal feuert.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getAuthCookie } from "../test-utils";
import { notifySuperadminsOfPdfFailure } from "../../server/services/invoice-pdf-orchestrator";
import { db } from "../../server/lib/db";
import { notifications, users } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";

beforeAll(async () => {
  await getAuthCookie();
});

async function getActiveSuperadminId(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.isSuperAdmin, true)))
    .limit(1);
  if (rows.length === 0) throw new Error("Kein aktiver Superadmin im Test-DB-Seed gefunden");
  return rows[0].id;
}

describe("PDF-Persist-Fehler — aktive Superadmin-Benachrichtigung", () => {
  it("erzeugt eine In-App-Benachrichtigung mit Rechnungsnummer und Fehlergrund", async () => {
    const superadminId = await getActiveSuperadminId();
    // Eindeutige, kollisionsfreie Pseudo-Rechnungs-ID (referenceId), damit der
    // 24h-Dedupe-Filter nicht mit Nachbartests kollidiert.
    const invoiceId = 900_000_000 + Math.floor(Math.random() * 50_000_000);
    const invoiceNumber = `TEST-PDFFAIL-${invoiceId}`;
    const reason = "ChromiumUnavailableError: Browser konnte nicht gestartet werden";

    await notifySuperadminsOfPdfFailure(invoiceId, invoiceNumber, reason);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, superadminId),
          eq(notifications.type, "invoice_pdf_persist_failed"),
          eq(notifications.referenceId, invoiceId),
        ),
      )
      .orderBy(desc(notifications.id));

    expect(rows.length).toBe(1);
    const n = rows[0];
    expect(n.referenceType).toBe("invoice");
    // Rechnungsnummer steht im Titel UND in der Nachricht.
    expect(n.title).toContain(invoiceNumber);
    expect(n.message).toContain(invoiceNumber);
    // Der Fehlergrund ist in der Nachricht enthalten.
    expect(n.message).toContain("ChromiumUnavailableError");
  });

  it("benachrichtigt pro Rechnung innerhalb von 24h nur einmal (Dedupe)", async () => {
    const superadminId = await getActiveSuperadminId();
    const invoiceId = 950_000_000 + Math.floor(Math.random() * 40_000_000);
    const invoiceNumber = `TEST-PDFFAIL-DEDUPE-${invoiceId}`;

    await notifySuperadminsOfPdfFailure(invoiceId, invoiceNumber, "Fehler A");
    await notifySuperadminsOfPdfFailure(invoiceId, invoiceNumber, "Fehler B");

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, superadminId),
          eq(notifications.type, "invoice_pdf_persist_failed"),
          eq(notifications.referenceId, invoiceId),
        ),
      );

    expect(rows.length).toBe(1);
  });
});
